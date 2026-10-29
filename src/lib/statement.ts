// カード明細の取り込み。登録済みの仮の取引と照合してから取り込む。
// 明細の各行を次の4つに分ける。
//   matched: 候補が1件だけで、金額、日付、利用先が合う。自動で結びつける
//   choose:  候補が複数、または金額だけ合うなど一致が弱い。利用者が選ぶまで新しい取引にしない
//   new:     候補がない。新しい取引になる
//   duplicate: 前に取り込んだ行と同じ。何もしない
// どの行とも結びつかなかった仮の取引は leftovers として返す。

import type { Account, Entry, Env } from "../types";
import { classifyMerchants, merchantKey } from "./classify";
import { diffDays } from "./dates";
import { looksLikeCharge } from "./keywords";
import { createEntry, getAccount, LedgerError, updateEntry } from "./ledger";
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

export async function previewStatement(env: Env, cardId: number, billingMonth: string, text: string): Promise<Preview> {
  const db = env.DB;
  const card = await getAccount(db, cardId);
  if (card.kind !== "card") throw new LedgerError("取り込み先にはカードを選んでください");
  if (!/^\d{4}-\d{2}$/.test(billingMonth)) throw new LedgerError("請求月は YYYY-MM で入れてください");
  const parsed = parseSMBC(text);
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
    const candidates = provisional
      // 分割払いは、手入力した利用額とも照合する。結びつけると、その月の支払額に置き換わる
      .filter((p) => (p.amount === r.paymentAmount || ((r.installmentCount ?? 1) > 1 && p.amount === r.usageAmount))
        && Math.abs(diffDays(p.date, r.usageDate)) <= WEAK_DAYS)
      .map((p) => ({ ...p, strong: Math.abs(diffDays(p.date, r.usageDate)) <= STRONG_DAYS && (similar(p.payee, r.merchant) || p.date === r.usageDate) }));
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
  };
}

export interface CommitChoice {
  /** 結びつける仮の取引。"new" なら新しい取引、"skip" なら取り込まない */
  link?: number | "new" | "skip";
  category_id?: number;
}

export async function commitStatement(env: Env, cardId: number, billingMonth: string, text: string,
  choices: Record<string, CommitChoice>, meta: { file_name?: string; r2_key?: string; user_id?: string | null }) {
  const db = env.DB;
  const preview = await previewStatement(env, cardId, billingMonth, text);
  const unresolved = preview.rows.filter((r) => r.status === "choose" && !choices[r.index]?.link);
  if (unresolved.length > 0) {
    throw new LedgerError(`候補を選んでいない行が${unresolved.length}件あります`);
  }
  const used = new Set<number>();
  const result = { linked: 0, created: 0, skipped: 0, duplicate: 0 };

  const imp = await db
    .prepare(`INSERT INTO statement_imports (account_id, billing_month, declared_total, imported_total, row_count, file_name, r2_key, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(cardId, billingMonth, preview.declared_total, preview.payment_total, preview.rows.length,
      meta.file_name ?? null, meta.r2_key ?? null, meta.user_id ?? null)
    .first<{ id: number }>();
  const importId = imp!.id;

  for (const row of preview.rows) {
    if (row.status === "duplicate") {
      result.duplicate++;
      continue;
    }
    const choice = choices[row.index] ?? {};
    let link: number | "new" | "skip" | null = choice.link ?? (row.status === "matched" ? row.match_entry_id : "new");
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
      if (used.has(link)) throw new LedgerError("同じ仮の取引を2つの行に結びつけています");
      used.add(link);
      const old = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(link).first<Entry>();
      if (!old || !old.provisional) throw new LedgerError(`仮の取引 ${link} が見つかりません`);
      // カテゴリ、メモ、立て替えの印は手入力のものを引き継ぎ、日付と金額は明細に合わせる
      const { results: oldLines } = await db
        .prepare("SELECT account_id, amount FROM lines WHERE entry_id = ?").bind(link).all<{ account_id: number; amount: number }>();
      const scale = row.paymentAmount;
      const others = oldLines.filter((l) => l.account_id !== cardId);
      const lines = others.length === 1
        ? [{ account_id: others[0].account_id, amount: scale }, { account_id: cardId, amount: -scale }]
        : undefined;
      if (!lines && -oldLines.filter((l) => l.account_id === cardId).reduce((s, l) => s + l.amount, 0) !== scale) {
        throw new LedgerError(`取引 ${link} はカテゴリが複数に分かれていて、金額が明細と違うため自動で合わせられません`);
      }
      // 手入力やレシートで日本語の店名が入っていればそちらを残し、明細の利用先はメモに回す
      const keepPayee = !!old.payee && /[\u3040-\u30ff\u4e00-\u9fff]/.test(old.payee) && old.payee !== row.merchant;
      await updateEntry(db, link, {
        ...common,
        payee: keepPayee ? old.payee : row.merchant,
        memo: [old.memo, keepPayee ? `明細の利用先: ${row.merchant}` : old.payee && old.payee !== row.merchant ? `入力時の利用先: ${old.payee}` : "", memo].filter(Boolean).join(" / "),
      }, lines, "明細と照合");
      result.linked++;
      continue;
    }
    // 新しい取引
    if (row.charge_account_id && !choice.category_id) {
      await createEntry(db, { ...common, kind: "transfer", memo, category_source: null, user_id: meta.user_id ?? null }, [
        { account_id: row.charge_account_id, amount: row.paymentAmount },
        { account_id: cardId, amount: -row.paymentAmount },
      ]);
    } else {
      const categoryId = choice.category_id ?? row.category_id;
      if (!categoryId) throw new LedgerError(`${row.merchant} のカテゴリが決まっていません`);
      await createEntry(db, {
        ...common, kind: "expense", memo,
        category_source: choice.category_id ? "user" : row.category_source,
        user_id: meta.user_id ?? null,
      }, [
        { account_id: categoryId, amount: row.paymentAmount },
        { account_id: cardId, amount: -row.paymentAmount },
      ]);
    }
    result.created++;
  }
  return { import_id: importId, ...result, declared_total: preview.declared_total, payment_total: preview.payment_total };
}
