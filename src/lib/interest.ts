// 借入の利息。定額払い(リボ)やキャッシングのように、年率で日割りした利息を毎月の返済額に含める。
// 利用の翌日から日ごとに、前日までの元金に 年率/365(うるう年は366) を掛けて足し、最後に円未満を切り捨てる。
// 締め日があれば前の締めの翌日から今回の締め日まで(メルカードの定額払いは月末締めで1日から末日)、
// なければ前回の返済日の翌日から今回の返済日までを数える。

import type { Account } from "../types";
import { addDays, addMonths, dayInMonth, nextBankDay } from "./dates";
import { chargeDate } from "./installments";

const yearDays = (date: string) => {
  const y = Number(date.slice(0, 4));
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
};

/** 請求月 month の返済に含める利息の期間。両端を含む */
export function interestPeriod(a: Pick<Account, "closing_day" | "payment_day">, month: string): { from: string; to: string } {
  if (a.closing_day) {
    const close = (m: string) => chargeDate({ closing_day: a.closing_day, payment_day: a.payment_day ?? a.closing_day }, m);
    return { from: addDays(close(addMonths(month, -1)), 1), to: close(month) };
  }
  const due = (m: string) => nextBankDay(dayInMonth(m, a.payment_day ?? 31));
  return { from: addDays(due(addMonths(month, -1)), 1), to: due(month) };
}

/** from から to までの日割りの利息。元金は仕訳の合計から日ごとに出す */
export async function accruedInterest(db: D1Database, a: Pick<Account, "id" | "annual_rate">, from: string, to: string): Promise<number> {
  if (!a.annual_rate || from > to) return 0;
  const { results } = await db
    .prepare(`SELECT e.date, -SUM(l.amount) AS amount FROM lines l JOIN entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND e.date < ? GROUP BY e.date ORDER BY e.date`)
    .bind(a.id, to)
    .all<{ date: string; amount: number }>();
  let i = 0;
  let owed = 0;
  let sum = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    while (i < results.length && results[i].date < d) owed += results[i++].amount;
    if (owed > 0) sum += (owed * a.annual_rate) / 100 / yearDays(d);
  }
  return Math.floor(sum + 1e-9);
}
