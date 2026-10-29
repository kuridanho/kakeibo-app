// 残高、集計、月末のまとめ(緩い締め)。

import type { Account, Env } from "../types";
import { addMonths, dayInMonth, diffDays, monthOf, monthsOfYear, nextBankDay, periodYear, todayJST } from "./dates";
import { createEntry } from "./ledger";

export async function getSetting(db: D1Database, key: string, fallback: string): Promise<string> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function yearStartMonth(db: D1Database): Promise<number> {
  const v = Number(await getSetting(db, "year_start_month", "1"));
  return v === 4 ? 4 : 1;
}

interface AccountBalance extends Account {
  balance: number;
  last_checked: string | null;
  check_overdue: boolean;
}

/** 口座ごとの残高と、手元にあるはずの現金 */
export async function balances(db: D1Database, today = todayJST()) {
  const { results } = await db
    .prepare(`SELECT a.*, COALESCE((SELECT SUM(l.amount) FROM lines l WHERE l.account_id = a.id), 0) AS raw,
        (SELECT MAX(date) FROM balance_checks b WHERE b.account_id = a.id) AS last_checked
      FROM accounts a WHERE a.type IN ('asset', 'liability') AND a.archived = 0 ORDER BY a.type, a.sort_order, a.id`)
    .all<Account & { raw: number; last_checked: string | null }>();
  const accounts: AccountBalance[] = results.map(({ raw, ...a }) => ({
    ...a,
    balance: a.type === "liability" ? -raw : raw,
    check_overdue: !!a.check_interval_days &&
      (!a.last_checked || diffDays(today, a.last_checked) > a.check_interval_days),
  }));

  // カードの未払いを請求月ごとに。引き落とし前のものはすべて保留として手元の現金から差し引く
  const { results: unpaid } = await db
    .prepare(`SELECT l.account_id, e.billing_month, -SUM(l.amount) AS amount
      FROM lines l JOIN entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE a.kind = 'card' GROUP BY l.account_id, e.billing_month`)
    .all<{ account_id: number; billing_month: string | null; amount: number }>();

  const liquid = accounts.filter((a) => a.type === "asset" && a.liquid);
  const liquidTotal = liquid.reduce((s, a) => s + a.balance, 0);
  const cards = accounts.filter((a) => a.kind === "card");
  const cardUnpaid = cards.reduce((s, a) => s + a.balance, 0);
  // 借入は残高全体ではなく、次の返済額だけを差し引く
  const loans = accounts.filter((a) => a.kind === "loan");
  const loanDue = loans.reduce((s, a) => s + Math.min(a.payment_amount ?? 0, Math.max(a.balance, 0)), 0);
  const nonLiquid = accounts.filter((a) => a.type === "asset" && !a.liquid);

  // 引き落とし口座の残高が、その口座から落ちる予定の額に足りるか
  const shortfalls = accounts
    .filter((a) => a.type === "asset")
    .map((bank) => {
      const due = accounts
        .filter((x) => (x.kind === "card" || x.kind === "loan") && x.payment_account_id === bank.id)
        .reduce((s, x) => s + (x.kind === "card" ? x.balance : Math.min(x.payment_amount ?? 0, x.balance)), 0);
      return { account_id: bank.id, name: bank.name, balance: bank.balance, due };
    })
    .filter((x) => x.due > x.balance);

  const assets = accounts.filter((a) => a.type === "asset").reduce((s, a) => s + a.balance, 0);
  const liabilities = accounts.filter((a) => a.type === "liability").reduce((s, a) => s + a.balance, 0);
  return {
    accounts,
    card_unpaid_by_month: unpaid.filter((u) => u.amount !== 0),
    liquid_total: liquidTotal,
    card_unpaid: cardUnpaid,
    loan_due: loanDue,
    available_cash: liquidTotal - cardUnpaid - loanDue,
    non_liquid_total: nonLiquid.reduce((s, a) => s + a.balance, 0),
    assets,
    liabilities,
    net_worth: assets - liabilities,
    shortfalls,
    overdue_checks: accounts.filter((a) => a.check_overdue).map((a) => ({ id: a.id, name: a.name, last_checked: a.last_checked })),
  };
}

/** 月のカテゴリごとの合計。支出は正、収入も正で返す */
export async function categoryTotals(db: D1Database, months: string[]): Promise<Record<string, Record<number, number>>> {
  const out: Record<string, Record<number, number>> = {};
  if (months.length === 0) return out;
  const from = `${months[0]}-01`;
  const to = `${months[months.length - 1]}-31`;
  const { results } = await db
    .prepare(`SELECT substr(e.report_date, 1, 7) AS month, l.account_id, a.type, SUM(l.amount) AS amount
      FROM lines l JOIN entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE a.type IN ('income', 'expense') AND e.report_date BETWEEN ? AND ?
      GROUP BY month, l.account_id`)
    .bind(from, to)
    .all<{ month: string; account_id: number; type: string; amount: number }>();
  for (const r of results) {
    (out[r.month] ??= {})[r.account_id] = r.type === "income" ? -r.amount : r.amount;
  }
  return out;
}

async function categoryList(db: D1Database) {
  const { results } = await db
    .prepare("SELECT id, name, type, archived, merged_into_id FROM accounts WHERE type IN ('income', 'expense') ORDER BY type, sort_order, id")
    .all<Pick<Account, "id" | "name" | "type" | "archived" | "merged_into_id">>();
  return results;
}

/** 月の集計。月末のまとめがあれば、その後に変わった額と理由も返す */
export async function monthSummary(db: D1Database, month: string) {
  const totals = (await categoryTotals(db, [month]))[month] ?? {};
  const cats = await categoryList(db);
  const report = await db.prepare("SELECT * FROM month_reports WHERE month = ?").bind(month)
    .first<{ month: string; totals: string; created_at: string }>();
  const snapshot: Record<string, number> | null = report ? JSON.parse(report.totals) : null;

  const rows = cats
    .map((c) => {
      const amount = totals[c.id] ?? 0;
      const at_report = snapshot ? (snapshot[c.id] ?? 0) : null;
      return { id: c.id, name: c.name, type: c.type, amount, at_report, changed: at_report === null ? 0 : amount - at_report };
    })
    .filter((r) => r.amount !== 0 || (r.at_report ?? 0) !== 0);

  let changes: { at: string; summary: string; delta: Record<string, number> }[] = [];
  if (report) {
    const { results } = await db
      .prepare(`SELECT at, summary, delta FROM entry_changes WHERE at > ? AND EXISTS
        (SELECT 1 FROM json_each(entry_changes.months) WHERE value = ?) ORDER BY at`)
      .bind(report.created_at.replace("T", " "), month)
      .all<{ at: string; summary: string; delta: string }>();
    changes = results.map((r) => ({ at: r.at, summary: r.summary, delta: JSON.parse(r.delta)[month] ?? {} }));
  }
  const sum = (t: string, key: "amount" | "at_report") => rows.filter((r) => r.type === t).reduce((s, r) => s + (r[key] ?? 0), 0);
  return {
    month,
    expense: sum("expense", "amount"),
    income: sum("income", "amount"),
    categories: rows,
    report: report ? { created_at: report.created_at, expense: sum("expense", "at_report"), income: sum("income", "at_report") } : null,
    changes,
  };
}

/** 集計の年(1月始まりか4月始まり)の月ごとの推移とカテゴリごとの合計 */
export async function yearSummary(db: D1Database, year?: number) {
  const start = await yearStartMonth(db);
  const y = year ?? periodYear(monthOf(todayJST()), start);
  const months = monthsOfYear(y, start);
  const totals = await categoryTotals(db, months);
  const cats = await categoryList(db);
  const type = new Map(cats.map((c) => [c.id, c.type]));
  const byMonth = months.map((m) => {
    const t = totals[m] ?? {};
    let expense = 0, income = 0;
    for (const [id, v] of Object.entries(t)) {
      if (type.get(Number(id)) === "income") income += v;
      else expense += v;
    }
    return { month: m, expense, income };
  });
  const byCategory = cats
    .map((c) => ({ id: c.id, name: c.name, type: c.type, amount: months.reduce((s, m) => s + (totals[m]?.[c.id] ?? 0), 0) }))
    .filter((c) => c.amount !== 0);
  return { year: y, year_start_month: start, months: byMonth, categories: byCategory };
}

/** 月末のまとめを作る。作り直すと、その時点の合計で置き換える */
export async function closeMonth(db: D1Database, month: string) {
  const totals = (await categoryTotals(db, [month]))[month] ?? {};
  await db
    .prepare(`INSERT INTO month_reports (month, totals, created_at) VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
      ON CONFLICT (month) DO UPDATE SET totals = excluded.totals, created_at = excluded.created_at`)
    .bind(month, JSON.stringify(totals))
    .run();
  return monthSummary(db, month);
}

/**
 * 引き落とし日が来たカードと借入の引き落としを記録する。
 * カードは請求月の利用の合計を、引き落とし口座からカードへの振替にする。
 * 借入は返済額を元金として扱う。利息の内訳は後から直せる。
 */
export async function recordDuePayments(db: D1Database, today = todayJST()) {
  const month = monthOf(today);
  const { results } = await db
    .prepare(`SELECT * FROM accounts WHERE kind IN ('card', 'loan') AND archived = 0
      AND payment_day IS NOT NULL AND payment_account_id IS NOT NULL`)
    .all<Account>();
  const created: number[] = [];
  // 引き落とし日が休みなら翌営業日に落ちる。月末の休みで翌月にずれた前月分も拾う
  const targets = results.flatMap((a) => [addMonths(month, -1), month].map((m) => ({ a, month: m, due: nextBankDay(dayInMonth(m, a.payment_day!)) })))
    .filter((t) => t.due <= today && (t.month === month || monthOf(t.due) === month));
  for (const { a, month, due } of targets) {
    const autoKey = `payment:${a.id}:${month}`;
    const exists = await db.prepare("SELECT id FROM entries WHERE auto_key = ?").bind(autoKey).first();
    if (exists) continue;
    let amount: number;
    if (a.kind === "card") {
      const row = await db
        .prepare(`SELECT -COALESCE(SUM(l.amount), 0) AS s FROM lines l JOIN entries e ON e.id = l.entry_id
          WHERE l.account_id = ? AND e.billing_month = ?`)
        .bind(a.id, month)
        .first<{ s: number }>();
      amount = row?.s ?? 0;
    } else {
      const bal = await db.prepare("SELECT -COALESCE(SUM(amount), 0) AS s FROM lines WHERE account_id = ?").bind(a.id).first<{ s: number }>();
      amount = Math.min(a.payment_amount ?? 0, bal?.s ?? 0);
    }
    if (amount <= 0) continue;
    created.push(await createEntry(db, {
      date: due,
      kind: a.kind === "card" ? "card_payment" : "transfer",
      payee: `${a.name} ${a.kind === "card" ? "引き落とし" : "返済"}`,
      source: "auto",
      billing_month: a.kind === "card" ? month : null,
      auto_key: autoKey,
    }, [
      { account_id: a.id, amount },
      { account_id: a.payment_account_id!, amount: -amount },
    ]));
  }
  return created;
}

/** 全テーブルをJSONにしてR2へ控える */
export async function backupToR2(env: Env, today = todayJST()) {
  if (!env.BUCKET) return null;
  const tables = ["accounts", "entries", "lines", "category_rules", "statement_imports", "balance_checks",
    "month_reports", "entry_changes", "settings"];
  const dump: Record<string, unknown[]> = {};
  for (const t of tables) dump[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  const key = `backups/${today}.json`;
  await env.BUCKET.put(key, JSON.stringify({ created_at: new Date().toISOString(), tables: dump }), {
    httpMetadata: { contentType: "application/json" },
  });
  return key;
}

/** 毎日1回の処理。引き落としの記録、月初の前月のまとめ、控え */
export async function daily(env: Env, now = new Date()) {
  const today = todayJST(now);
  await recordDuePayments(env.DB, today);
  if (today.endsWith("-01")) {
    const prev = addMonths(monthOf(today), -1);
    const exists = await env.DB.prepare("SELECT 1 FROM month_reports WHERE month = ?").bind(prev).first();
    if (!exists) await closeMonth(env.DB, prev);
  }
  await backupToR2(env, today);
}
