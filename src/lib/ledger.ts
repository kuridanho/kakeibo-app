// 仕訳の読み書き。取引を書き込むときは必ずここを通し、変更の記録も同時に残す。

import type { Account, Entry, Line } from "../types";
import { billingMonth, monthOf } from "./dates";

export class LedgerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type EntryFields = Partial<Omit<Entry, "id" | "created_at" | "updated_at">> & {
  date: string;
  kind: string;
};

const entryColumns = [
  "date", "report_date", "kind", "payee", "memo", "source", "provisional", "billing_month",
  "statement_import_id", "statement_key", "category_source", "advance", "settled",
  "related_entry_id", "counterparty", "auto_key", "user_id",
] as const;

export async function getAccount(db: D1Database, id: number): Promise<Account> {
  const a = await db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
  if (!a) throw new LedgerError(`項目が見つかりません: ${id}`, 404);
  return a;
}

/** 統合されたカテゴリをたどって、今使われているカテゴリを返す */
export async function resolveAccount(db: D1Database, id: number): Promise<Account> {
  let a = await getAccount(db, id);
  for (let i = 0; a.merged_into_id && i < 10; i++) a = await getAccount(db, a.merged_into_id);
  return a;
}

export async function getEntry(db: D1Database, id: number): Promise<{ entry: Entry; lines: Line[] }> {
  const entry = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first<Entry>();
  if (!entry) throw new LedgerError(`取引が見つかりません: ${id}`, 404);
  const { results } = await db
    .prepare("SELECT account_id, amount FROM lines WHERE entry_id = ? ORDER BY id")
    .bind(id)
    .all<Line>();
  return { entry, lines: results };
}

function validateLines(lines: Line[]) {
  if (lines.length < 2) throw new LedgerError("仕訳には2行以上が必要です");
  for (const l of lines) {
    if (!Number.isInteger(l.amount)) throw new LedgerError("金額は円単位の整数にしてください");
  }
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw new LedgerError(`借方と貸方が一致しません(差 ${sum})`);
}

type Delta = Record<string, Record<string, number>>;

/** カテゴリ(収入と支出)ごとの増減を、集計月ごとに求める */
async function categoryDelta(db: D1Database, before: { month: string; lines: Line[] } | null,
  after: { month: string; lines: Line[] } | null): Promise<Delta> {
  const ids = new Set([...(before?.lines ?? []), ...(after?.lines ?? [])].map((l) => l.account_id));
  if (ids.size === 0) return {};
  const { results } = await db
    .prepare(`SELECT id FROM accounts WHERE type IN ('income', 'expense') AND id IN (${[...ids].map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: number }>();
  const categories = new Set(results.map((r) => r.id));
  const delta: Delta = {};
  const add = (month: string, lines: Line[], sign: number) => {
    for (const l of lines) {
      if (!categories.has(l.account_id)) continue;
      const m = (delta[month] ??= {});
      m[l.account_id] = (m[l.account_id] ?? 0) + sign * l.amount;
      if (m[l.account_id] === 0) delete m[l.account_id];
    }
  };
  if (before) add(before.month, before.lines, -1);
  if (after) add(after.month, after.lines, 1);
  for (const k of Object.keys(delta)) if (Object.keys(delta[k]).length === 0) delete delta[k];
  return delta;
}

function changeStatement(db: D1Database, entryId: number | null, action: string, delta: Delta, summary: string) {
  const months = Object.keys(delta);
  return db
    .prepare("INSERT INTO entry_changes (entry_id, action, months, delta, summary) VALUES (?, ?, ?, ?, ?)")
    .bind(entryId, action, JSON.stringify(months), JSON.stringify(delta), summary);
}

function describe(e: Pick<Entry, "date" | "payee" | "kind">) {
  return `${e.date} ${e.payee || e.kind}`;
}

/** 仕訳を新しく作る。作った取引のidを返す */
export async function createEntry(db: D1Database, fields: EntryFields, lines: Line[]): Promise<number> {
  validateLines(lines);
  const values = { report_date: fields.date, ...fields };
  const cols = entryColumns.filter((c) => values[c] !== undefined);
  const inserted = await db
    .prepare(`INSERT INTO entries (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) RETURNING id`)
    .bind(...cols.map((c) => values[c] ?? null))
    .first<{ id: number }>();
  const id = inserted!.id;
  const delta = await categoryDelta(db, null, { month: monthOf(values.report_date!), lines });
  await db.batch([
    ...lines.map((l) =>
      db.prepare("INSERT INTO lines (entry_id, account_id, amount) VALUES (?, ?, ?)").bind(id, l.account_id, l.amount)),
    changeStatement(db, id, "create", delta, `追加 ${describe(values as Entry)}`),
  ]);
  return id;
}

/** 仕訳を書き換える。lines を渡したときは明細行を入れ替える */
export async function updateEntry(db: D1Database, id: number, fields: Partial<EntryFields>, lines?: Line[],
  reason = "変更"): Promise<void> {
  const before = await getEntry(db, id);
  if (lines) validateLines(lines);
  const merged = { ...before.entry, ...fields } as Entry;
  if (fields.date && fields.report_date === undefined && before.entry.report_date === before.entry.date) {
    merged.report_date = fields.date;
  }
  const cols = entryColumns.filter((c) => c in fields || c === "report_date");
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE entries SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
      .bind(...cols.map((c) => merged[c] ?? null), id),
  ];
  const newLines = lines ?? before.lines;
  if (lines) {
    stmts.push(db.prepare("DELETE FROM lines WHERE entry_id = ?").bind(id));
    for (const l of lines) {
      stmts.push(db.prepare("INSERT INTO lines (entry_id, account_id, amount) VALUES (?, ?, ?)").bind(id, l.account_id, l.amount));
    }
  }
  // 回収は元の取引の日で集計するので、元の取引の日が変わったら回収の集計日も動かす
  if (merged.report_date !== before.entry.report_date) {
    stmts.push(db.prepare("UPDATE entries SET report_date = ? WHERE related_entry_id = ? AND kind = 'recovery'")
      .bind(merged.report_date, id));
  }
  const delta = await categoryDelta(db,
    { month: monthOf(before.entry.report_date), lines: before.lines },
    { month: monthOf(merged.report_date), lines: newLines });
  stmts.push(changeStatement(db, id, "update", delta, `${reason} ${describe(merged)}`));
  await db.batch(stmts);
}

export async function deleteEntry(db: D1Database, id: number): Promise<void> {
  const before = await getEntry(db, id);
  const { results: recoveries } = await db
    .prepare("SELECT id FROM entries WHERE related_entry_id = ?").bind(id).all<{ id: number }>();
  for (const r of recoveries) await deleteEntry(db, r.id);
  const delta = await categoryDelta(db, { month: monthOf(before.entry.report_date), lines: before.lines }, null);
  await db.batch([
    db.prepare("DELETE FROM lines WHERE entry_id = ?").bind(id),
    db.prepare("UPDATE balance_checks SET adjustment_entry_id = NULL WHERE adjustment_entry_id = ?").bind(id),
    db.prepare("DELETE FROM entries WHERE id = ?").bind(id),
    changeStatement(db, id, "delete", delta, `削除 ${describe(before.entry)}`),
  ]);
}

export async function logChange(db: D1Database, action: string, delta: Delta, summary: string) {
  await changeStatement(db, null, action, delta, summary).run();
}

/** 口座の残高。資産は借方残(正)、負債は貸方残を正にして返す */
export async function balanceOf(db: D1Database, account: Pick<Account, "id" | "type">, asOf?: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(l.amount), 0) AS s FROM lines l JOIN entries e ON e.id = l.entry_id
      WHERE l.account_id = ? ${asOf ? "AND e.date <= ?" : ""}`)
    .bind(...(asOf ? [account.id, asOf] : [account.id]))
    .first<{ s: number }>();
  const s = row?.s ?? 0;
  return account.type === "liability" || account.type === "equity" || account.type === "income" ? -s : s;
}

/** 画面の入力(支出、収入、振替)から仕訳の行を組み立てる */
export interface SimpleInput {
  kind: "expense" | "income" | "transfer";
  date: string;
  amount: number;
  /** 支出: 支払方法、振替: 移す元 */
  from_account_id?: number;
  /** 収入: 受け取った口座、振替: 移す先 */
  to_account_id?: number;
  category_id?: number;
  payee?: string;
  memo?: string;
  advance?: boolean;
  /** 支出をレシートの品目ごとにカテゴリへ分けるとき。金額の合計は amount と同じにする */
  items?: { category_id: number; amount: number }[];
}

export async function buildSimple(db: D1Database, input: SimpleInput): Promise<{ fields: EntryFields; lines: Line[] }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new LedgerError("日付は YYYY-MM-DD で入れてください");
  if (!Number.isInteger(input.amount) || input.amount === 0) throw new LedgerError("金額を円単位で入れてください");
  const fields: EntryFields = {
    date: input.date,
    kind: input.kind,
    payee: input.payee ?? "",
    memo: input.memo ?? "",
    advance: input.advance ? 1 : 0,
  };
  const need = (id: number | undefined, what: string) => {
    if (!id) throw new LedgerError(`${what}を選んでください`);
    return resolveAccount(db, id);
  };
  let lines: Line[];
  let paidWith: Account;
  if (input.kind === "expense") {
    paidWith = await need(input.from_account_id, "支払方法");
    if (input.items?.length) {
      const byCat = new Map<number, number>();
      for (const item of input.items) {
        if (!Number.isInteger(item.amount)) throw new LedgerError("品目の金額は円単位で入れてください");
        const cat = await need(item.category_id, "品目のカテゴリ");
        if (cat.type !== "expense") throw new LedgerError("品目には支出のカテゴリを選んでください");
        byCat.set(cat.id, (byCat.get(cat.id) ?? 0) + item.amount);
      }
      const sum = [...byCat.values()].reduce((s, v) => s + v, 0);
      if (sum !== input.amount) throw new LedgerError(`品目の合計 ${sum.toLocaleString("ja-JP")}円が金額 ${input.amount.toLocaleString("ja-JP")}円と合いません`);
      lines = [...byCat].filter(([, v]) => v !== 0).map(([id, v]) => ({ account_id: id, amount: v }));
      lines.push({ account_id: paidWith.id, amount: -input.amount });
    } else {
      const cat = await need(input.category_id, "カテゴリ");
      if (cat.type !== "expense") throw new LedgerError("支出には支出のカテゴリを選んでください");
      lines = [{ account_id: cat.id, amount: input.amount }, { account_id: paidWith.id, amount: -input.amount }];
    }
  } else if (input.kind === "income") {
    const to = await need(input.to_account_id, "受け取り先");
    if (to.type !== "asset") throw new LedgerError("受け取り先には財布や銀行口座などを選んでください");
    const cat = await need(input.category_id, "カテゴリ");
    if (cat.type !== "income") throw new LedgerError("収入には収入のカテゴリを選んでください");
    lines = [{ account_id: to.id, amount: input.amount }, { account_id: cat.id, amount: -input.amount }];
    paidWith = to;
  } else if (input.kind === "transfer") {
    paidWith = await need(input.from_account_id, "移す元");
    const to = await need(input.to_account_id, "移す先");
    if (paidWith.id === to.id) throw new LedgerError("移す元と先が同じです");
    lines = [{ account_id: to.id, amount: input.amount }, { account_id: paidWith.id, amount: -input.amount }];
  } else {
    throw new LedgerError("種類は支出、収入、振替のどれかです");
  }
  // カードで払った分は請求月を決めておき、明細を取り込むカードなら照合するまで仮にする
  if (paidWith.kind === "card" && input.kind !== "income") {
    fields.provisional = paidWith.statement_import ? 1 : 0;
    if (paidWith.closing_day && paidWith.payment_day) {
      fields.billing_month = billingMonth(input.date, paidWith.closing_day, paidWith.payment_day);
    }
  } else {
    fields.provisional = 0;
    fields.billing_month = null;
  }
  return { fields, lines };
}
