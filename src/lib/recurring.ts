// 繰り返しの取引。毎朝の処理で、その日までに来た回を一度ずつ記録する。

import { addMonths, dayInMonth, monthOf, nextBankDay, todayJST } from "./dates";
import { buildSimple, createEntry, LedgerError, type SimpleInput } from "./ledger";

export interface Recurring {
  id: number;
  kind: "expense" | "income" | "transfer";
  amount: number;
  every: "month" | "year";
  day: number;
  shift_holiday: number;
  first_date: string;
  end_date: string | null;
  from_account_id: number | null;
  to_account_id: number | null;
  category_id: number | null;
  payee: string;
  memo: string;
  active: number;
  user_id: string | null;
}

/** その月の回の日付。毎年のときは first_date の月だけ */
export function occurrence(r: Pick<Recurring, "every" | "day" | "shift_holiday" | "first_date">, month: string): string | null {
  if (r.every === "year" && month.slice(5) !== r.first_date.slice(5, 7)) return null;
  const d = dayInMonth(month, r.day);
  return r.shift_holiday ? nextBankDay(d) : d;
}

export function toInput(r: Recurring, date: string): SimpleInput {
  return {
    kind: r.kind, date, amount: r.amount,
    from_account_id: r.from_account_id ?? undefined, to_account_id: r.to_account_id ?? undefined,
    category_id: r.category_id ?? undefined, payee: r.payee, memo: r.memo,
  };
}

/** 中身が記録できる形かを先に確かめる */
export async function validate(db: D1Database, r: Recurring) {
  if (!Number.isInteger(r.day) || r.day < 1 || r.day > 31) throw new LedgerError("日は1から31で入れてください");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.first_date)) throw new LedgerError("始める日を入れてください");
  await buildSimple(db, toInput(r, r.first_date));
}

/** 今日までに来た回を記録する。同じ回は auto_key で二度記録しない */
export async function recordRecurring(db: D1Database, today = todayJST()) {
  const { results } = await db.prepare("SELECT * FROM recurring WHERE active = 1").all<Recurring>();
  const created: number[] = [];
  const month = monthOf(today);
  for (const r of results) {
    // 休みで翌月にずれた前月の回も拾う
    for (const m of [addMonths(month, -1), month]) {
      const date = occurrence(r, m);
      if (!date || date > today || date < r.first_date || (r.end_date && date > r.end_date)) continue;
      if (m !== month && monthOf(date) !== month) continue;
      const autoKey = `recurring:${r.id}:${m}`;
      if (await db.prepare("SELECT 1 FROM entries WHERE auto_key = ?").bind(autoKey).first()) continue;
      try {
        const { fields, lines } = await buildSimple(db, toInput(r, date));
        created.push(await createEntry(db, { ...fields, source: "recurring", category_source: "user", auto_key: autoKey, user_id: r.user_id }, lines));
      } catch (e) {
        // 口座を消したなどで記録できない回は飛ばし、ほかの繰り返しは続ける
        console.error(`繰り返し ${r.id} を記録できませんでした`, e);
      }
    }
  }
  return created;
}
