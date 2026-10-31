// 借入の利息。定額払い(リボ)やメルペイスマートマネーのように、年率で日割りした利息を毎月の返済額に含める。
// 利用や返済の翌日から日ごとに、前日までの元金に 年率/365(うるう年は366) を掛けて足し、最後に円未満を切り捨てる。
// 利息は締めた期間の翌月の返済に含める。締め日がなければ月末締めとし、前月1日から末日までの分を今月の返済に入れる。
// 年率があれば、返済の義務は前月末の元金までで、その月に借りた分は翌月から返す(メルペイスマートマネー規約 第3条、第4条)。

import type { Account } from "../types";
import { addDays, addMonths, dayInMonth, monthOf, nextBankDay, todayJST } from "./dates";
import { chargeDate } from "./installments";

type Loan = Pick<Account, "id" | "annual_rate" | "closing_day" | "payment_day" | "payment_amount"> & Partial<Pick<Account, "first_payment_date">>;

/** 請求月 month が最初の返済日の月より前なら、その月の返済はない */
export const beforeFirstPayment = (a: Partial<Pick<Account, "first_payment_date">>, month: string) =>
  !!a.first_payment_date && month < monthOf(a.first_payment_date);

const yearDays = (date: string) => {
  const y = Number(date.slice(0, 4));
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
};

/** 請求月 month の返済に含める利息の期間。両端を含む */
export function interestPeriod(a: Pick<Account, "closing_day" | "payment_day">, month: string): { from: string; to: string } {
  const card = { closing_day: a.closing_day ?? 31, payment_day: a.payment_day ?? a.closing_day ?? 31 };
  return { from: addDays(chargeDate(card, addMonths(month, -1)), 1), to: chargeDate(card, month) };
}

/** 日 date の終わりの借りている額。開始残高は前からある借入なので日付を問わず数える */
async function owedAt(db: D1Database, id: number, date: string): Promise<number> {
  const row = await db.prepare(`SELECT -COALESCE(SUM(l.amount), 0) AS s FROM lines l JOIN entries e ON e.id = l.entry_id
    WHERE l.account_id = ? AND (e.date <= ? OR e.kind = 'opening')`).bind(id, date).first<{ s: number }>();
  return row?.s ?? 0;
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

/** 請求月 month の返済額と、そのうちの利息 */
export async function loanPayment(db: D1Database, a: Loan, month: string): Promise<{ amount: number; interest: number }> {
  const { from, to } = interestPeriod(a, month);
  const interest = await accruedInterest(db, a, from, to);
  // 年率のある借入は、前月末までに借りた分だけを返す
  const owed = Math.min(await owedAt(db, a.id, "9999-12-31"),
    a.annual_rate ? await owedAt(db, a.id, dayInMonth(addMonths(month, -1), 31)) : Infinity);
  const amount = Math.max(0, Math.min(a.payment_amount ?? 0, owed + interest));
  // 返済額が利息に届かないときは、全額を利息にする
  return { amount, interest: Math.min(interest, amount) };
}

/** 借入の画面に出す利息。次の返済とその内訳、今の期間にたまった利息、これまでに払った利息 */
export async function loanOverview(db: D1Database, a: Loan & Pick<Account, "kind">, today = todayJST()) {
  const month = monthOf(today);
  const recorded = await db.prepare("SELECT 1 FROM entries WHERE auto_key = ?").bind(`payment:${a.id}:${month}`).first();
  let dueMonth = recorded || !a.payment_day ? addMonths(month, 1) : month;
  if (beforeFirstPayment(a, dueMonth)) dueMonth = monthOf(a.first_payment_date!);
  const next = a.payment_day ? { month: dueMonth, date: nextBankDay(dayInMonth(dueMonth, a.payment_day)), ...(await loanPayment(db, a, dueMonth)) } : null;
  // 今たまっている利息は、まだどの返済にも入っていない期間の分
  const current = interestPeriod(a, addMonths(dueMonth, 1));
  const accrued = await accruedInterest(db, a, current.from, today < current.to ? today : current.to);
  const paid = await db.prepare(`SELECT COALESCE(SUM(l.amount), 0) AS s FROM lines l JOIN entries e ON e.id = l.entry_id
      JOIN accounts c ON c.id = l.account_id
    WHERE c.seed_key = 'interest' AND e.id IN (SELECT entry_id FROM lines WHERE account_id = ?)`).bind(a.id).first<{ s: number }>();
  return { annual_rate: a.annual_rate, next, accrued: { from: current.from, to: today, amount: accrued }, paid_total: paid?.s ?? 0 };
}
