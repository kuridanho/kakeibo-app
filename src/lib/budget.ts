// 来月の予算。来月末の手元資金の見込みから、そのときまだ払っていないカードの利用と、残しておく額を引いて出す。
// 来月にカードで使う分(カードで払う固定費など)は手元からは再来月に出るが、使える額からは来月のうちに引く。

import type { Account, Env } from "../types";
import { addMonths, dayInMonth, monthOf, nextBankDay, todayJST } from "./dates";
import { balanceOf, buildSimple, resolveAccount } from "./ledger";
import { cardDue, getSetting } from "./reports";
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

/**
 * その月にまだ記録されていない、繰り返しと引き落とし。
 * 祝日で翌月にずれる回があるので、前月の回も見て、実際の日付がその月のものだけを拾う。
 */
async function pendingItems(db: D1Database, month: string, liquidIds: Set<number>, today: string,
  cardOwed: Map<number, number>): Promise<BudgetItem[]> {
  const items: BudgetItem[] = [];
  const owe = (id: number, amount: number) => { if (cardOwed.has(id)) cardOwed.set(id, cardOwed.get(id)! + amount); };
  const months = [addMonths(month, -1), month];

  const { results: recurring } = await db.prepare("SELECT * FROM recurring WHERE active = 1").all<Recurring>();
  for (const r of recurring) {
    for (const m of months) {
      const date = occurrence(r, m);
      if (!date || monthOf(date) !== month) continue;
      if (date < r.first_date || (r.end_date && date > r.end_date)) continue;
      const autoKey = `recurring:${r.id}:${m}`;
      if (await db.prepare("SELECT 1 FROM entries WHERE auto_key = ?").bind(autoKey).first()) continue;

      let cashDelta = 0;
      try {
        const { lines } = await buildSimple(db, toInput(r, date));
        cashDelta = lines.filter((l) => liquidIds.has(l.account_id)).reduce((s, l) => s + l.amount, 0);
        // カードの行は負債を増やす向きが負なので、符号を返して未払いに足す
        for (const l of lines) owe(l.account_id, -l.amount);
      } catch {
        // 口座を消したなどで記録できない回は、予定にも入れない
        continue;
      }
      const from = r.from_account_id ? await resolveAccount(db, r.from_account_id) : null;
      const kind = r.kind === "expense" && from?.kind === "card" ? "card" : r.kind;
      if (cashDelta === 0 && kind !== "card") continue;
      items.push({ date, label: r.payee || "繰り返し", amount: Math.abs(r.amount), cash_delta: cashDelta, kind });
    }
  }

  const { results: payers } = await db
    .prepare(`SELECT * FROM accounts WHERE kind IN ('card', 'loan') AND archived = 0
      AND payment_day IS NOT NULL AND payment_account_id IS NOT NULL`)
    .all<Account>();
  for (const a of payers) {
    for (const billMonth of months) {
      const due = nextBankDay(dayInMonth(billMonth, a.payment_day!));
      if (monthOf(due) !== month) continue;
      const autoKey = `payment:${a.id}:${billMonth}`;
      if (await db.prepare("SELECT 1 FROM entries WHERE auto_key = ?").bind(autoKey).first()) continue;

      let amount: number;
      if (a.kind === "card") {
        amount = await cardDue(db, a.id, billMonth);
      } else {
        amount = Math.min(a.payment_amount ?? 0, Math.max(await balanceOf(db, a, today), 0));
      }
      if (amount <= 0) continue;
      owe(a.id, -amount);
      const cashDelta = liquidIds.has(a.payment_account_id!) ? -amount : 0;
      if (cashDelta === 0) continue;
      items.push({
        date: due,
        label: `${a.name} ${a.kind === "card" ? "引き落とし" : "返済"}`,
        amount,
        cash_delta: cashDelta,
        kind: "payment",
      });
    }
  }

  return items.sort((x, y) => x.date.localeCompare(y.date));
}

/** 来月末の手元資金から、余裕を引いた使える額 */
export async function nextMonthBudget(db: D1Database, today = todayJST()): Promise<NextMonthBudget> {
  const current = monthOf(today);
  const month = addMonths(current, 1);
  const liquid = await liquidAccounts(db);
  const liquidIds = new Set(liquid.map((a) => a.id));

  // カードごとの来月末の未払い。記録済みの分から始め、まだ記録されていない利用と引き落としを足し引きする
  const { results: cards } = await db.prepare("SELECT * FROM accounts WHERE kind = 'card' AND archived = 0").all<Account>();
  const cardOwed = new Map<number, number>();
  for (const c of cards) cardOwed.set(c.id, await balanceOf(db, c, `${month}-31`));

  const pendingCurrent = await pendingItems(db, current, liquidIds, today, cardOwed);
  const pendingNext = await pendingItems(db, month, liquidIds, today, cardOwed);
  const cardUnpaid = [...cardOwed.values()].reduce((s, v) => s + Math.max(v, 0), 0);
  const recordedNext = await recordedItems(db, `${month}-01`, `${month}-31`);

  // 記録済みは残高に入っているので、まだ記録されていない分だけ足す
  let projected = 0;
  for (const a of liquid) projected += await balanceOf(db, a, `${month}-31`);
  for (const item of [...pendingCurrent, ...pendingNext]) projected += item.cash_delta;

  const nextItems = [...recordedNext, ...pendingNext].sort((x, y) => x.date.localeCompare(y.date));
  const change = nextItems.reduce((s, item) => s + item.cash_delta, 0);
  const buffer = Number(await getSetting(db, "budget_buffer", "0")) || 0;

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
    budget: projected - cardUnpaid - buffer,
  };
}
