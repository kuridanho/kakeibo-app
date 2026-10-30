// カレンダー用の月の一覧。日ごとの支出と収入の合計と、今日より後の予定(繰り返し、一度きりの予定、分割払いの回、カードの引き落とし、返済)。
// 日ごとの合計は集計と同じく report_date で数える。立て替えの回収は元の取引の日の支出を減らす。

import type { Account } from "../types";
import { dayInMonth, nextBankDay, todayJST } from "./dates";
import { pendingPayments } from "./installments";
import type { Planned as PlannedRow } from "./planned";
import { occurrence, type Recurring } from "./recurring";
import { cardDue } from "./reports";

export interface Planned {
  date: string;
  label: string;
  amount: number;
  kind: "expense" | "income" | "transfer" | "payment";
  /** 一度きりの予定のとき、その id */
  planned_id?: number;
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

  // 一度きりの予定は、日が過ぎてもまだ確かめていなければ出しておく
  const { results: ps } = await db
    .prepare("SELECT * FROM planned WHERE entry_id IS NULL AND date BETWEEN ? AND ?")
    .bind(`${month}-01`, `${month}-31`).all<PlannedRow>();
  for (const p of ps) planned.push({ date: p.date, label: p.payee || "予定", amount: p.amount, kind: p.kind, planned_id: p.id });

  // 分割払いのまだ請求に載っていない回
  for (const p of await pendingPayments(db, { from: `${month}-01`, to: `${month}-31` })) {
    if (p.date <= today) continue;
    planned.push({ date: p.date, label: `${p.plan.payee || "分割払い"} ${p.number}/${p.plan.count}回`, amount: p.amount, kind: "expense" });
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
