// 繰り返しでない、一度きりの予定。自動では記録せず、その日が来たらホームで確かめてもらい、確かめた内容を記録にする。

import { buildSimple, LedgerError, type SimpleInput } from "./ledger";

export interface Planned {
  id: number;
  kind: "expense" | "income" | "transfer";
  amount: number;
  date: string;
  from_account_id: number | null;
  to_account_id: number | null;
  category_id: number | null;
  payee: string;
  memo: string;
  entry_id: number | null;
  user_id: string | null;
}

export function plannedInput(p: Planned): SimpleInput {
  return {
    kind: p.kind, date: p.date, amount: p.amount,
    from_account_id: p.from_account_id ?? undefined, to_account_id: p.to_account_id ?? undefined,
    category_id: p.category_id ?? undefined, payee: p.payee, memo: p.memo,
  };
}

/** 中身が記録できる形かを先に確かめる */
export async function validatePlanned(db: D1Database, p: Planned) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new LedgerError("日付を入れてください");
  await buildSimple(db, plannedInput(p));
}

/** まだ記録していない予定。to を渡すとその日までのものだけ */
export async function openPlanned(db: D1Database, to?: string): Promise<Planned[]> {
  const { results } = await db
    .prepare(`SELECT * FROM planned WHERE entry_id IS NULL ${to ? "AND date <= ?" : ""} ORDER BY date, id`)
    .bind(...(to ? [to] : []))
    .all<Planned>();
  return results;
}
