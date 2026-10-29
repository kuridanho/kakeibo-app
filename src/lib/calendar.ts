// カレンダー用の月の一覧。日ごとの支出と収入の合計と、今日より後の予定(繰り返し、カードの引き落とし、返済)。
// 日ごとの合計は集計と同じく report_date で数える。立て替えの回収は元の取引の日の支出を減らす。

import type { Account } from "../types";
import { dayInMonth, nextBankDay, todayJST } from "./dates";
import { occurrence, type Recurring } from "./recurring";
import { cardDue } from "./reports";

export interface Planned {
  date: string;
  label: string;
  amount: number;
  kind: "expense" | "income" | "transfer" | "payment";
}

export async function calendarMonth(db: D1Database, month: string, today = todayJST()) {
  const { results: totals } = await db
    .prepare(`SELECT e.report_date AS date, a.type, SUM(l.amount) AS amount FROM lines l
      JOIN entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE e.report_date BETWEEN ? AND ? AND a.type IN ('expense', 'income') GROUP BY e.report_date, a.type`)
    .bind(`${month}-01`, `${month}-31`)
    .all<{ date: string; type: string; amount: number }>();
  const days: Record<string, { expense: number; income: number }> = {};
  for (const t of totals) {
    const d = (days[t.date] ??= { expense: 0, income: 0 });
    if (t.type === "expense") d.expense += t.amount;
    else d.income += -t.amount;
  }

  const planned: Planned[] = [];
  const { results: rs } = await db.prepare("SELECT * FROM recurring WHERE active = 1").all<Recurring>();
  for (const r of rs) {
    const date = occurrence(r, month);
    if (!date || date <= today || date < r.first_date || (r.end_date && date > r.end_date)) continue;
    planned.push({ date, label: r.payee || "繰り返し", amount: r.amount, kind: r.kind });
  }

  const { results: payers } = await db
    .prepare(`SELECT * FROM accounts WHERE kind IN ('card', 'loan') AND archived = 0 AND payment_day IS NOT NULL`)
    .all<Account>();
  for (const a of payers) {
    const date = nextBankDay(dayInMonth(month, a.payment_day!));
    if (date <= today) continue;
    let amount: number;
    if (a.kind === "card") {
      amount = await cardDue(db, a.id, month);
    } else {
      amount = a.payment_amount ?? 0;
    }
    if (amount > 0) planned.push({ date, label: `${a.name} ${a.kind === "card" ? "引き落とし" : "返済"}`, amount, kind: "payment" });
  }
  planned.sort((x, y) => x.date.localeCompare(y.date));
  return { month, today, days, planned };
}
