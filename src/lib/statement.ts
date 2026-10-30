// カード明細の取り込み。登録済みの仮の取引と照合してから取り込む。
// 明細の各行を次の4つに分ける。
//   matched: 候補が1件だけで、金額、日付、利用先が合う。自動で結びつける
//   choose:  候補が複数、または金額だけ合うなど一致が弱い。利用者が選ぶまで新しい取引にしない
//   new:     候補がない。新しい取引になる
//   duplicate: 前に取り込んだ行と同じ。何もしない
// どの行とも結びつかなかった仮の取引は leftovers として返す。
// 利用者はどの行も、候補に出なかった取引(ほかの支払方法で入れたものを含む)に結びつけられる。
// 利用者が選んだ結びつきは statement_links に残し、次からは金額が違っても候補に出す。

import type { Account, Entry, Env, Line } from "../types";
import { classifyMerchants, merchantKey } from "./classify";
import { diffDays } from "./dates";
import { looksLikeCharge } from "./keywords";
import { createEntry, getAccount, getEntry, LedgerError, resolveAccount, updateEntry } from "./ledger";
import { parseSMBC, type StatementRow } from "./smbc";

export interface Candidate {
  entry_id: number;
  date: string;
  payee: string;
  amount: number;
  category_id: number | null;
  strong: boolean;
}

export interface PreviewRow extends StatementRow {
  index: number;
  key: string;
  status: "matched" | "choose" | "new" | "duplicate";
  candidates: Candidate[];
  /** 自動で結びつける仮の取引 */
  match_entry_id: number | null;
  /** 新しい取引にするときのカテゴリ、またはチャージ先の電子マネー */
  category_id: number | null;
  category_source: string | null;
  charge_account_id: number | null;
}

export interface Preview {
  card_name: string;
  billing_month: string;
  declared_total: number | null;
  payment_total: number;
  rows: PreviewRow[];
  leftovers: Candidate[];
  /** このカードの仮の取引すべて。どの行にも選べるようにする */
  provisional: Candidate[];
}

const STRONG_DAYS = 3;
const WEAK_DAYS = 10;

/** 同じ明細に同じ日、同じ店、同じ額の行が2つあっても区別できるよう、出てきた順番を鍵に含める */
function rowKeys(accountId: number, billingMonth: string, rows: StatementRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    // 分割払いは同じ利用が毎月載るので、請求月も鍵に入れる
    const installment = (r.installmentCount ?? 1) > 1 ? `|${billingMonth}#${r.installmentNumber ?? ""}` : "";
    const base = `${accountId}|${r.usageDate}|${merchantKey(r.merchant)}|${r.usageAmount}${installment}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}|${n}`;
  });
}

function similar(a: string, b: string): boolean {
  const x = merchantKey(a).replace(/\s/g, "");
  const y = merchantKey(b).replace(/\s/g, "");
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x) || x.slice(0, 4) === y.slice(0, 4);
}

async function provisionalEntries(db: D1Database, cardId: number): Promise<Candidate[]> {
  // 仮の取引のうち、このカードの貸方に載っているもの。金額はカードの貸方の額
  const { results } = await db
    .prepare(`SELECT e.id AS entry_id, e.date, e.payee, -l.amount AS amount,
        (SELECT l2.account_id FROM lines l2 JOIN accounts a ON a.id = l2.account_id
          WHERE l2.entry_id = e.id AND a.type = 'expense' ORDER BY l2.amount DESC LIMIT 1) AS category_id
      FROM entries e JOIN lines l ON l.entry_id = e.id
      WHERE e.provisional = 1 AND l.account_id = ? AND l.amount < 0 ORDER BY e.date`)
    .bind(cardId)
    .all<Omit<Candidate, "strong">>();
  return results.map((r) => ({ ...r, strong: false }));
}

/** 前に利用者が結びつけた、明細の利用先と取引の内容の組み合わせ */
async function learnedLinks(db: D1Database, merchants: string[]): Promise<Map<string, Set<string>>> {
  const keys = [...new Set(merchants.map(merchantKey))];
  const links = new Map<string, Set<string>>();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT merchant_key, payee FROM statement_links WHERE merchant_key IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ merchant_key: string; payee: string }>();
    for (const r of results) {
      if (!links.has(r.merchant_key)) links.set(r.merchant_key, new Set());
      links.get(r.merchant_key)!.add(r.payee);
    }
  }
  return links;
}

export async function previewStatement(env: Env, cardId: number, billingMonth: string, text: string): Promise<Preview> {
  const db = env.DB;
  const card = await getAccount(db, cardId);
  if (card.kind !== "card") throw new LedgerError("取り込み先にはカードを選んでください");
  if (!/^\d{4}-\d{2}$/.test(billingMonth)) throw new LedgerError("請求月は YYYY-MM で入れてください");
  const parsed = parseSMBC(text);
  if (parsed.billingMonth && parsed.billingMonth !== billingMonth) {
    throw new LedgerError(`この明細の請求月は ${Number(parsed.billingMonth.slice(5))}月です。請求月を ${parsed.billingMonth} にしてください`);
  }
  const keys = rowKeys(cardId, billingMonth, parsed.rows);

  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const { results } = await db
      .prepare(`SELECT statement_key FROM entries WHERE statement_key IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ statement_key: string }>();
    for (const r of results) existing.add(r.statement_key);
  }

  const provisional = await provisionalEntries(db, cardId);
  const learned = await learnedLinks(db, parsed.rows.map((r) => r.merchant));
  const taken = new Set<number>();
  const { results: emoney } = await db
    .prepare("SELECT * FROM accounts WHERE type = 'asset' AND kind = 'emoney' AND archived = 0").all<Account>();

  const rows: PreviewRow[] = parsed.rows.map((r, index) => {
    const key = keys[index];
    const base: PreviewRow = {
      ...r, index, key, status: "new", candidates: [], match_entry_id: null,
      category_id: null, category_source: null, charge_account_id: null,
    };
    if (existing.has(key)) return { ...base, status: "duplicate" };
    // 前にこの利用先と結びつけた内容の取引は、外貨の換算などで金額が違っても候補にする
    const known = learned.get(merchantKey(r.merchant));
    const knows = (p: Candidate) => !!known?.has(merchantKey(p.payee));
    const candidates = provisional
      // 前に出た行が結びつけた仮の取引は、もう候補にしない
      .filter((p) => !taken.has(p.entry_id))
      // 分割払いは、手入力した利用額とも照合する。結びつけると、その月の支払額に置き換わる
      .filter((p) => (p.amount === r.paymentAmount || ((r.installmentCount ?? 1) > 1 && p.amount === r.usageAmount) || knows(p))
        && Math.abs(diffDays(p.date, r.usageDate)) <= WEAK_DAYS)
      .map((p) => ({ ...p, strong: Math.abs(diffDays(p.date, r.usageDate)) <= STRONG_DAYS
        && (similar(p.payee, r.merchant) || p.date === r.usageDate || knows(p)) }));
    if (candidates.length === 0) return base;
    // 返品や、日付が大きくずれる候補は自動では決めない
    if (candidates.length === 1 && candidates[0].strong && r.paymentAmount > 0) {
      taken.add(candidates[0].entry_id);
      return { ...base, status: "matched", candidates, match_entry_id: candidates[0].entry_id };
    }
    return { ...base, status: "choose", candidates };
  });

  // 新しく作る行のカテゴリを決める。電子マネーへのチャージらしい行は振替の候補にする
  const toClassify: string[] = [];
  for (const row of rows) {
    if (row.status === "duplicate" || row.status === "matched") continue;
    if (looksLikeCharge(row.merchant)) {
      const target = emoney.find((a) => {
        const name = a.name.toUpperCase();
        return merchantKey(row.merchant).includes(name) || name.split(/\s/).some((w) => w.length >= 3 && merchantKey(row.merchant).includes(w));
      });
      if (target) {
        row.charge_account_id = target.id;
        continue;
      }
    }
    toClassify.push(row.merchant);
  }
  const classified = await classifyMerchants(env, toClassify);
  for (const row of rows) {
    if (row.charge_account_id || row.status === "duplicate" || row.status === "matched") continue;
    const c = classified.get(merchantKey(row.merchant));
    row.category_id = c?.account_id ?? null;
    row.category_source = c?.source ?? null;
  }

  const leftovers = provisional.filter((p) => !taken.has(p.entry_id) &&
    !rows.some((r) => r.status === "choose" && r.candidates.some((c) => c.entry_id === p.entry_id)));

  return {
    card_name: parsed.cardName,
    billing_month: billingMonth,
    declared_total: parsed.declaredTotal,
    payment_total: parsed.paymentTotal,
    rows,
    leftovers,
    provisional,
  };
}

export interface CommitChoice {
  /** 結びつける仮の取引。"new" なら新しい取引、"skip" なら取り込まない */
  link?: number | "new" | "skip";
  category_id?: number;
}

interface CommitPlan {
  row: PreviewRow;
  choice: CommitChoice;
  link: number | "new" | "skip";
  /** 新しい支出にするときに使う、統合済みのカテゴリ */
  category_id: number | null;
}

/**
 * 書き込む前に、結びつけ先とカテゴリを確かめる。
 * ここで弾けば、明細の記録だけが残る中途半端な状態を作らない。
 */
async function planCommit(db: D1Database, preview: Preview, cardId: number,
  choices: Record<string, CommitChoice>): Promise<CommitPlan[]> {
  const plans: CommitPlan[] = [];
  const used = new Set<number>();
  for (const row of preview.rows) {
    if (row.status === "duplicate") {
      plans.push({ row, choice: {}, link: "skip", category_id: null });
      continue;
    }
    const choice = choices[row.index] ?? {};
    const link = choice.link ?? (row.status === "matched" ? row.match_entry_id : "new");
    if (link === "skip") {
      plans.push({ row, choice, link, category_id: null });
      continue;
    }
    if (typeof link === "number") {
      if (used.has(link)) throw new LedgerError("同じ仮の取引を2つの行に結びつけています");
      used.add(link);
      const old = await db.prepare("SELECT id, kind, statement_key FROM entries WHERE id = ?").bind(link)
        .first<{ id: number; kind: string; statement_key: string | null }>();
      if (!old) throw new LedgerError(`取引 ${link} が見つかりません`);
      if (old.statement_key) throw new LedgerError(`取引 ${link} はもう明細の行と結びついています`);
      const { results: oldLines } = await db
        .prepare("SELECT account_id, amount FROM lines WHERE entry_id = ?").bind(link).all<Line>();
      if (oldLines.some((l) => l.account_id === cardId)) {
        // カテゴリが複数に分かれていて金額が違う取引は、自動では合わせられない
        const others = oldLines.filter((l) => l.account_id !== cardId);
        const cardAmount = -oldLines.filter((l) => l.account_id === cardId).reduce((s, l) => s + l.amount, 0);
        if (others.length !== 1 && cardAmount !== row.paymentAmount) {
          throw new LedgerError(`取引 ${link} はカテゴリが複数に分かれていて、金額が明細と違うため自動で合わせられません`);
        }
      } else {
        // ほかの支払方法で入れた支出。支払方法をこのカードに付け替える
        if (old.kind !== "expense") throw new LedgerError(`取引 ${link} は支出ではないため、明細の行と結びつけられません`);
        if (row.paymentAmount <= 0) throw new LedgerError(`${row.merchant} は返品の行なので、このカードの取引にだけ結びつけられます`);
        const debit = oldLines.filter((l) => l.amount > 0);
        const debitTotal = debit.reduce((s, l) => s + l.amount, 0);
        if (debit.length !== 1 && debitTotal !== row.paymentAmount) {
          throw new LedgerError(`取引 ${link} はカテゴリが複数に分かれていて、金額が明細と違うため自動で合わせられません`);
        }
      }
      plans.push({ row, choice, link, category_id: null });
      continue;
    }
    // 新しい取引。カテゴリか、チャージ先の口座を先に確かめる
    if (row.charge_account_id && !choice.category_id) {
      const target = await getAccount(db, row.charge_account_id);
      if (target.type !== "asset") throw new LedgerError(`${target.name} にはチャージできません`);
      plans.push({ row, choice, link: "new", category_id: null });
      continue;
    }
    const categoryId = choice.category_id ?? row.category_id;
    if (!categoryId) throw new LedgerError(`${row.merchant} のカテゴリが決まっていません`);
    const category = await resolveAccount(db, categoryId);
    if (category.type !== "expense") throw new LedgerError("支出には支出のカテゴリを選んでください");
    plans.push({ row, choice, link: "new", category_id: category.id });
  }
  return plans;
}

/** 取り込みの途中で失敗したときに、作った仕訳と明細の記録を戻す */
async function rollbackStatement(db: D1Database, importId: number, created: number[],
  snapshots: Map<number, { entry: Entry; lines: Line[] }>, changeMark: number) {
  const stmts: D1PreparedStatement[] = [];
  for (const id of created) {
    stmts.push(db.prepare("DELETE FROM lines WHERE entry_id = ?").bind(id));
    stmts.push(db.prepare("DELETE FROM entries WHERE id = ?").bind(id));
  }
  for (const [id, { entry, lines }] of snapshots) {
    stmts.push(db.prepare(`UPDATE entries SET date = ?, report_date = ?, payee = ?, memo = ?, source = ?, provisional = ?,
      billing_month = ?, statement_import_id = ?, statement_key = ?, category_source = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(entry.date, entry.report_date, entry.payee, entry.memo, entry.source, entry.provisional,
        entry.billing_month, entry.statement_import_id, entry.statement_key, entry.category_source, id));
    stmts.push(db.prepare("DELETE FROM lines WHERE entry_id = ?").bind(id));
    for (const l of lines) stmts.push(db.prepare("INSERT INTO lines (entry_id, account_id, amount) VALUES (?, ?, ?)").bind(id, l.account_id, l.amount));
  }
  // この取り込みで足した変更の記録も消す
  const touched = [...created, ...snapshots.keys()];
  if (touched.length > 0) {
    stmts.push(db.prepare(`DELETE FROM entry_changes WHERE id > ? AND entry_id IN (${touched.map(() => "?").join(",")})`)
      .bind(changeMark, ...touched));
  }
  stmts.push(db.prepare("DELETE FROM statement_imports WHERE id = ?").bind(importId));
  await db.batch(stmts);
}

export async function commitStatement(env: Env, cardId: number, billingMonth: string, text: string,
  choices: Record<string, CommitChoice>, meta: { file_name?: string; r2_key?: string; user_id?: string | null }) {
  const db = env.DB;
  const preview = await previewStatement(env, cardId, billingMonth, text);
  const unresolved = preview.rows.filter((r) => r.status === "choose" && !choices[r.index]?.link);
  if (unresolved.length > 0) {
    throw new LedgerError(`候補を選んでいない行が${unresolved.length}件あります`);
  }
  // 先に全部確かめてから書き込む
  const plans = await planCommit(db, preview, cardId, choices);
  const result = { linked: 0, created: 0, skipped: 0, duplicate: 0 };

  const imp = await db
    .prepare(`INSERT INTO statement_imports (account_id, billing_month, declared_total, imported_total, row_count, file_name, r2_key, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(cardId, billingMonth, preview.declared_total, preview.payment_total, preview.rows.length,
      meta.file_name ?? null, meta.r2_key ?? null, meta.user_id ?? null)
    .first<{ id: number }>();
  const importId = imp!.id;
  const changeMark = (await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM entry_changes").first<{ id: number }>())!.id;
  const created: number[] = [];
  const snapshots = new Map<number, { entry: Entry; lines: Line[] }>();
  const learn: [string, string][] = [];

  try {
    for (const plan of plans) {
      const { row, choice, link } = plan;
      if (row.status === "duplicate") {
        result.duplicate++;
        continue;
      }
      if (link === "skip") {
        result.skipped++;
        continue;
      }
      const memo = [row.subCardName, row.installmentCount && row.installmentCount > 1
        ? `分割 ${row.installmentNumber}/${row.installmentCount}回 (利用額 ${row.usageAmount.toLocaleString("ja-JP")}円)` : "", row.note]
        .filter(Boolean).join(" ");
      const common = {
        date: row.usageDate,
        payee: row.merchant,
        source: "statement",
        provisional: 0,
        billing_month: billingMonth,
        statement_import_id: importId,
        statement_key: row.key,
      };
      if (typeof link === "number") {
        const snapshot = await getEntry(db, link);
        snapshots.set(link, snapshot);
        // カテゴリ、メモ、立て替えの印は手入力のものを引き継ぎ、日付と金額は明細に合わせる
        const old = snapshot.entry;
        const scale = row.paymentAmount;
        let lines: Line[] | undefined;
        let paidWith = "";
        if (snapshot.lines.some((l) => l.account_id === cardId)) {
          const others = snapshot.lines.filter((l) => l.account_id !== cardId);
          lines = others.length === 1
            ? [{ account_id: others[0].account_id, amount: scale }, { account_id: cardId, amount: -scale }]
            : undefined;
        } else {
          // ほかの支払方法で入れた支出は、支払方法をこのカードに替える
          const debit = snapshot.lines.filter((l) => l.amount > 0);
          lines = debit.length === 1
            ? [{ account_id: debit[0].account_id, amount: scale }, { account_id: cardId, amount: -scale }]
            : [...debit.map((l) => ({ account_id: l.account_id, amount: l.amount })), { account_id: cardId, amount: -scale }];
          const credit = snapshot.lines.filter((l) => l.amount < 0).map((l) => l.account_id);
          const names = await Promise.all(credit.map(async (id) => (await getAccount(db, id)).name));
          paidWith = names.length ? `入力時の支払方法: ${names.join("、")}` : "";
        }
        // 手入力やレシートで日本語の店名が入っていればそちらを残し、明細の利用先はメモに回す
        const keepPayee = !!old.payee && /[\u3040-\u30ff\u4e00-\u9fff]/.test(old.payee) && old.payee !== row.merchant;
        await updateEntry(db, link, {
          ...common,
          payee: keepPayee ? old.payee : row.merchant,
          memo: [old.memo, keepPayee ? `明細の利用先: ${row.merchant}` : old.payee && old.payee !== row.merchant ? `入力時の利用先: ${old.payee}` : "", paidWith, memo].filter(Boolean).join(" / "),
        }, lines, "明細と照合");
        // 利用者が選んだ結びつきは、次の取り込みで候補に出すために覚えておく
        if (typeof choice.link === "number" && old.payee) learn.push([merchantKey(row.merchant), merchantKey(old.payee)]);
        result.linked++;
        continue;
      }
      // 新しい取引
      if (row.charge_account_id && !choice.category_id) {
        created.push(await createEntry(db, { ...common, kind: "transfer", memo, category_source: null, user_id: meta.user_id ?? null }, [
          { account_id: row.charge_account_id, amount: row.paymentAmount },
          { account_id: cardId, amount: -row.paymentAmount },
        ]));
      } else {
        created.push(await createEntry(db, {
          ...common, kind: "expense", memo,
          category_source: choice.category_id ? "user" : row.category_source,
          user_id: meta.user_id ?? null,
        }, [
          { account_id: plan.category_id!, amount: row.paymentAmount },
          { account_id: cardId, amount: -row.paymentAmount },
        ]));
      }
      result.created++;
    }
  } catch (e) {
    await rollbackStatement(db, importId, created, snapshots, changeMark);
    throw e;
  }
  if (learn.length > 0) {
    await db.batch(learn.map(([merchant, payee]) => db
      .prepare(`INSERT INTO statement_links (merchant_key, payee, user_id) VALUES (?, ?, ?)
        ON CONFLICT (merchant_key, payee) DO UPDATE SET count = count + 1, updated_at = datetime('now')`)
      .bind(merchant, payee, meta.user_id ?? null)));
  }
  return { import_id: importId, ...result, declared_total: preview.declared_total, payment_total: preview.payment_total };
}
