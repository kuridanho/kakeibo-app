// カレンダー用の月の一覧。日ごとの支出と収入の合計と、今日より後の予定(繰り返し、一度きりの予定、分割払いの回、カードの引き落とし、返済)。
// カードで払う予定と分割払いの回は、使う日ではなくカードの引き落とし日に、引き落としの内訳として並べる。
// 日ごとの合計は集計と同じく report_date で数える。立て替えの回収は元の取引の日の支出を減らす。

import type { Account } from "../types";
import { advanceItems } from "./budget";
import { addMonths, dayInMonth, monthOf, nextBankDay, todayJST } from "./dates";
import { beforeFirstPayment } from "./interest";
import type { Planned as PlannedRow } from "./planned";
import { occurrence, type Recurring } from "./recurring";
import { cardDueAhead } from "./reports";

export interface Planned {
  date: string;
  label: string;
  amount: number;
  /** card は引き落としの内訳。額は引き落としに含まれるので、入る額と出る額には数えない */
  kind: "expense" | "income" | "transfer" | "payment" | "card";
  /** 引き落としの内訳のとき、そのカードの名前 */
  via?: string;
  /** 一度きりの予定のとき、その id */
  planned_id?: number;
  /** カードの引き落としのうち、明細でまだ確定していない額 */
  pending?: number;
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
  const { results: payers } = await db
    .prepare(`SELECT * FROM accounts WHERE kind IN ('card', 'loan') AND archived = 0 AND payment_day IS NOT NULL`)
    .all<Account>();
  // 締め日と引き落とし日のあるカードで払う予定は、引き落としのほうに並べる
  const billed = new Set(payers.filter((a) => a.kind === "card" && a.closing_day).map((a) => a.id));
  const viaCard = (p: { kind: string; from_account_id: number | null }) => p.kind === "expense" && p.from_account_id !== null && billed.has(p.from_account_id);
  const { results: rs } = await db.prepare("SELECT * FROM recurring WHERE active = 1").all<Recurring>();
  for (const r of rs) {
    if (viaCard(r)) continue;
    const date = occurrence(r, month);
    if (!date || date <= today || date < r.first_date || (r.end_date && date > r.end_date)) continue;
    planned.push({ date, label: r.payee || "繰り返し", amount: r.amount, kind: r.kind });
  }

  // 一度きりの予定は、日が過ぎてもまだ確かめていなければ出しておく
  const { results: ps } = await db
    .prepare("SELECT * FROM planned WHERE entry_id IS NULL AND date BETWEEN ? AND ?")
    .bind(`${month}-01`, `${month}-31`).all<PlannedRow>();
  for (const p of ps) if (!viaCard(p)) planned.push({ date: p.date, label: p.payee || "予定", amount: p.amount, kind: p.kind, planned_id: p.id });

  for (const a of payers) {
    const date = nextBankDay(dayInMonth(month, a.payment_day!));
    if (date <= today || beforeFirstPayment(a, month)) continue;
    if (a.kind === "card") {
      const { amount, usage, pending } = await cardDueAhead(db, a, month);
      if (amount > 0) planned.push({ date, label: `${a.name} 引き落とし`, amount, kind: "payment", ...(pending ? { pending } : {}) });
      for (const u of usage) planned.push({ date, label: u.label, amount: u.amount, kind: "card", via: a.name, planned_id: u.planned_id });
    } else if (a.payment_amount) {
      planned.push({ date, label: `${a.name} 返済`, amount: a.payment_amount, kind: "payment" });
    }
  }
  // 来月使える額と同じく、回収していない立て替えは来月の初めに戻る見込みとして出す
  if (month === addMonths(monthOf(today), 1)) {
    for (const a of await advanceItems(db, month)) planned.push({ date: a.date, label: a.label, amount: a.amount, kind: "income" });
  }
  planned.sort((x, y) => x.date.localeCompare(y.date));
  return { month, today, days, planned };
}
