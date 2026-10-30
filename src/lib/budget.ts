// 来月の予算。来月末の手元資金の見込みから、貯金に回す額を引いて出す。
// 引くのは来月のうちに手元から出る分だけで、再来月以降に引き落とされるカードの利用は引かない。

import type { Account, Env } from "../types";
import { addMonths, dayInMonth, monthOf, nextBankDay, todayJST } from "./dates";
import { pendingPayments } from "./installments";
import { balanceOf, buildSimple, resolveAccount } from "./ledger";
import { cardDueAhead, getSetting } from "./reports";
import { type Planned, plannedInput } from "./planned";
import { occurrence, toInput, type Recurring } from "./recurring";

export interface BudgetItem {
  date: string;
  label: string;
  /** 正の額 */
  amount: number;
  /** 手元資金の増減。収入は +、支出は − */
  cash_delta: number;
  kind: "income" | "expense" | "transfer" | "payment" | "card";
}

export interface NextMonthBudget {
  month: string;
  today: string;
  opening_liquid: number;
  income: BudgetItem[];
  expenses: BudgetItem[];
  /** カードで払う固定費。手元からは引かないので、参考として返す */
  card_fixed: BudgetItem[];
  projected_liquid: number;
  /** 来月末の時点で、まだ引き落とされていないカードの利用 */
  card_unpaid: number;
  buffer: number;
  budget: number;
}

async function liquidAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db
    .prepare("SELECT * FROM accounts WHERE type = 'asset' AND liquid = 1 AND archived = 0")
    .all<Account>();
  return results;
}

/** 記録済みの仕訳のうち、手元口座を動かすもの。カード利用や口座間の振替は0になる */
async function recordedItems(db: D1Database, from: string, to: string): Promise<BudgetItem[]> {
  const { results } = await db
    .prepare(`SELECT e.id, e.date, e.payee, e.kind,
        COALESCE(SUM(CASE WHEN a.type = 'asset' AND a.liquid = 1 AND a.archived = 0 THEN l.amount ELSE 0 END), 0) AS delta
      FROM entries e JOIN lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
      WHERE e.date BETWEEN ? AND ? AND e.kind != 'opening'
      GROUP BY e.id ORDER BY e.date, e.id`)
    .bind(from, to)
    .all<{ id: number; date: string; payee: string; kind: string; delta: number }>();
  return results
    .filter((r) => r.delta !== 0)
    .map((r) => ({
      date: r.date,
      label: r.payee || r.kind,
      amount: Math.abs(r.delta),
      cash_delta: r.delta,
      kind: r.kind === "card_payment" ? "payment" : r.kind === "transfer" ? "transfer" : r.delta > 0 ? "income" : "expense",
    }));
}

/** 候補の auto_key のうち、すでに記録された取引があるもの。1回の問い合わせで調べる */
async function recordedKeys(db: D1Database, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const { results } = await db
    .prepare(`SELECT auto_key FROM entries WHERE auto_key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .all<{ auto_key: string }>();
  return new Set(results.map((r) => r.auto_key));
}

/**
 * その月にまだ記録されていない、繰り返しと引き落とし。
 * 祝日で翌月にずれる回があるので、前月の回も見て、実際の日付がその月のものだけを拾う。
 * 問い合わせを1件ずつ待つと遅いので、候補を先に洗い出してまとめて調べる。
 */
async function pendingItems(db: D1Database, month: string, liquidIds: Set<number>, today: string,
  cardOwed: Map<number, number>): Promise<BudgetItem[]> {
  // まだ記録されていないカードの利用と引き落としを、カードごとの未払いに足し引きする
  const owe = (id: number, amount: number) => { if (cardOwed.has(id)) cardOwed.set(id, cardOwed.get(id)! + amount); };
  const months = [addMonths(month, -1), month];
  // 一度きりの予定は、その月の分と、今月なら日が過ぎてまだ確かめていない分も見る
  const plannedFrom = month === monthOf(today) ? "0000-00-00" : `${month}-01`;
  const [{ results: recurring }, { results: payers }, { results: planned }] = await Promise.all([
    db.prepare("SELECT * FROM recurring WHERE active = 1").all<Recurring>(),
    db.prepare(`SELECT * FROM accounts WHERE kind IN ('card', 'loan') AND archived = 0
      AND payment_day IS NOT NULL AND payment_account_id IS NOT NULL`).all<Account>(),
    db.prepare("SELECT * FROM planned WHERE entry_id IS NULL AND date BETWEEN ? AND ?")
      .bind(plannedFrom, `${month}-31`).all<Planned>(),
  ]);

  const recurringDue = recurring.flatMap((r) => months.flatMap((m) => {
    const date = occurrence(r, m);
    if (!date || monthOf(date) !== month) return [];
    if (date < r.first_date || (r.end_date && date > r.end_date)) return [];
    return [{ r, date, key: `recurring:${r.id}:${m}` }];
  }));
  const paymentDue = payers.flatMap((a) => months.flatMap((billMonth) => {
    const due = nextBankDay(dayInMonth(billMonth, a.payment_day!));
    return monthOf(due) === month ? [{ a, billMonth, due, key: `payment:${a.id}:${billMonth}` }] : [];
  }));
  const done = await recordedKeys(db, [...recurringDue, ...paymentDue].map((x) => x.key));

  const fromRecurring = Promise.all(recurringDue.filter((x) => !done.has(x.key)).map(async ({ r, date }): Promise<BudgetItem | null> => {
    let cashDelta = 0;
    let from: Account | null;
    try {
      const [{ lines }, account] = await Promise.all([
        buildSimple(db, toInput(r, date)),
        r.from_account_id ? resolveAccount(db, r.from_account_id) : null,
      ]);
      cashDelta = lines.filter((l) => liquidIds.has(l.account_id)).reduce((s, l) => s + l.amount, 0);
      // カードの行は負債が増える向きが負なので、符号を返して未払いに足す
      for (const l of lines) owe(l.account_id, -l.amount);
      from = account;
    } catch {
      // 口座を消したなどで記録できない回は、予定にも入れない
      return null;
    }
    const kind = r.kind === "expense" && from?.kind === "card" ? "card" : r.kind;
    if (cashDelta === 0 && kind !== "card") return null;
    return { date, label: r.payee || "繰り返し", amount: Math.abs(r.amount), cash_delta: cashDelta, kind };
  }));

  const fromPayments = Promise.all(paymentDue.filter((x) => !done.has(x.key)).map(async ({ a, billMonth, due }): Promise<BudgetItem | null> => {
    const amount = a.kind === "card"
      ? (await cardDueAhead(db, a, billMonth)).amount
      : Math.min(a.payment_amount ?? 0, Math.max(await balanceOf(db, a, today), 0));
    if (amount <= 0) return null;
    owe(a.id, -amount);
    const cashDelta = liquidIds.has(a.payment_account_id!) ? -amount : 0;
    if (cashDelta === 0) return null;
    return {
      date: due,
      label: `${a.name} ${a.kind === "card" ? "引き落とし" : "返済"}`,
      amount,
      cash_delta: cashDelta,
      kind: "payment",
    };
  }));

  const fromPlanned = Promise.all(planned.map(async (p): Promise<BudgetItem | null> => {
    let cashDelta = 0;
    let from: Account | null;
    try {
      const [{ lines }, account] = await Promise.all([
        buildSimple(db, plannedInput(p)),
        p.from_account_id ? resolveAccount(db, p.from_account_id) : null,
      ]);
      cashDelta = lines.filter((l) => liquidIds.has(l.account_id)).reduce((s, l) => s + l.amount, 0);
      for (const l of lines) owe(l.account_id, -l.amount);
      from = account;
    } catch {
      return null;
    }
    const kind = p.kind === "expense" && from?.kind === "card" ? "card" : p.kind;
    if (cashDelta === 0 && kind !== "card") return null;
    return { date: p.date, label: p.payee || "予定", amount: p.amount, cash_delta: cashDelta, kind };
  }));

  // まだ記録していない分割払いの回。カードの未払いに足すだけで、手元からは引き落としのときに出る
  const fromInstallments = (await pendingPayments(db, { from: month === monthOf(today) ? "0000-00-00" : `${month}-01`, to: `${month}-31` }))
    .filter((p) => month === monthOf(today) || monthOf(p.date) === month)
    .map((p): BudgetItem => {
      owe(p.plan.card_id, p.amount);
      return { date: p.date, label: `${p.plan.payee || "分割払い"} ${p.number}/${p.plan.count}回`, amount: p.amount, cash_delta: 0, kind: "card" };
    });

  const items = [...await fromRecurring, ...await fromPayments, ...await fromPlanned, ...fromInstallments].filter((x): x is BudgetItem => x !== null);
  return items.sort((x, y) => x.date.localeCompare(y.date));
}

/** 来月末の手元資金から、余裕を引いた使える額 */
export async function nextMonthBudget(db: D1Database, today = todayJST()): Promise<NextMonthBudget> {
  const current = monthOf(today);
  const month = addMonths(current, 1);
  const liquid = await liquidAccounts(db);
  const liquidIds = new Set(liquid.map((a) => a.id));

  // カードごとの来月末の未払い。記録済みの残高から始める
  const { results: cards } = await db.prepare("SELECT * FROM accounts WHERE kind = 'card' AND archived = 0").all<Account>();
  const owed = await Promise.all(cards.map((c) => balanceOf(db, c, `${month}-31`)));
  const cardOwed = new Map(cards.map((c, i) => [c.id, owed[i]]));

  const [pendingCurrent, pendingNext, recordedNext, balances, bufferSetting] = await Promise.all([
    pendingItems(db, current, liquidIds, today, cardOwed),
    pendingItems(db, month, liquidIds, today, cardOwed),
    recordedItems(db, `${month}-01`, `${month}-31`),
    Promise.all(liquid.map((a) => balanceOf(db, a, `${month}-31`))),
    getSetting(db, "budget_buffer", "0"),
  ]);

  // 記録済みは残高に入っているので、まだ記録されていない分だけ足す
  let projected = balances.reduce((s, b) => s + b, 0);
  for (const item of [...pendingCurrent, ...pendingNext]) projected += item.cash_delta;

  const nextItems = [...recordedNext, ...pendingNext].sort((x, y) => x.date.localeCompare(y.date));
  const change = nextItems.reduce((s, item) => s + item.cash_delta, 0);
  const buffer = Number(bufferSetting) || 0;
  const cardUnpaid = [...cardOwed.values()].reduce((s, v) => s + Math.max(v, 0), 0);

  return {
    month,
    today,
    opening_liquid: projected - change,
    income: nextItems.filter((i) => i.cash_delta > 0),
    expenses: nextItems.filter((i) => i.cash_delta < 0),
    card_fixed: pendingNext.filter((i) => i.kind === "card" && i.cash_delta === 0),
    projected_liquid: projected,
    card_unpaid: cardUnpaid,
    buffer,
    budget: projected - buffer,
  };
}
