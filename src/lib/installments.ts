// カードの分割払い。記録のときに分割にしたもの、あとから分割にしたもの、明細で見つけた分割を同じ形で持つ。
// 毎月の支払いは、その回が請求に載る日(締め日。1回目は利用日)に、その月の請求月の取引として記録する。
// まだ記録していない回は、カードの引き落とし額と来月使える額の見込みに足す。
// 支払額のうち利用額を回数で割った分はカテゴリへ、残りは利息・手数料へ入れる。

import type { Account, Entry, Line } from "../types";
import { addMonths, billingMonth, dayInMonth, monthOf, todayJST } from "./dates";
import { createEntry, deleteEntry, type EntryFields, getAccount, getEntry, LedgerError, resolveAccount, updateEntry } from "./ledger";

export interface Installment {
  id: number;
  card_id: number;
  category_id: number;
  payee: string;
  memo: string;
  purchase_date: string;
  principal: number;
  count: number;
  first_month: string;
  first_payment: number;
  payment: number;
  start_number: number;
  origin: string;
  user_id: string | null;
}

export interface Payment {
  number: number;
  /** 請求月 */
  month: string;
  /** 記録する日 */
  date: string;
  amount: number;
  /** 利用額にあたる分 */
  principal: number;
  /** 手数料にあたる分 */
  fee: number;
  key: string;
}

type Card = Pick<Account, "id" | "closing_day" | "payment_day" | "statement_import">;

export const installmentKey = (id: number, n: number) => `installment:${id}:${n}`;

export function parseInstallmentKey(key: string | null): { id: number; number: number } | null {
  const m = /^installment:(\d+):(\d+)$/.exec(key ?? "");
  return m ? { id: Number(m[1]), number: Number(m[2]) } : null;
}

/** 手数料を足した総額を回数で割る。割り切れない端数は1回目に寄せる */
export function defaultPayments(principal: number, count: number, fee = 0) {
  const total = principal + fee;
  const payment = Math.floor(total / count);
  return { payment, first_payment: total - payment * (count - 1) };
}

/** 請求月 month の請求に載る日。その月に引き落とされる締めの締め日 */
export function chargeDate(card: Pick<Account, "closing_day" | "payment_day">, month: string): string {
  if (!card.closing_day || !card.payment_day) return dayInMonth(addMonths(month, -1), 31);
  const closingMonth = card.payment_day > card.closing_day ? month : addMonths(month, -1);
  return dayInMonth(closingMonth, card.closing_day);
}

/** 回ごとの請求月、記録する日、支払額と内訳 */
export function schedule(p: Installment, card: Pick<Account, "closing_day" | "payment_day">): Payment[] {
  const base = Math.floor(p.principal / p.count);
  const purchaseMonth = card.closing_day && card.payment_day
    ? billingMonth(p.purchase_date, card.closing_day, card.payment_day) : null;
  const out: Payment[] = [];
  for (let n = 1; n <= p.count; n++) {
    const month = addMonths(p.first_month, n - 1);
    const amount = n === 1 ? p.first_payment : p.payment;
    // 支払額が利用額の割り当てより少ないとき(明細から見積もった分割など)は、全部を利用額の分にする
    const principal = Math.min(n === 1 ? p.principal - base * (p.count - 1) : base, amount);
    const charge = chargeDate(card, month);
    const date = month === purchaseMonth || charge < p.purchase_date ? p.purchase_date : charge;
    out.push({ number: n, month, date, amount, principal, fee: amount - principal, key: installmentKey(p.id, n) });
  }
  return out;
}

async function interestCategory(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT id FROM accounts WHERE seed_key = 'interest'").first<{ id: number }>();
  if (!row) throw new LedgerError("利息・手数料のカテゴリがありません");
  return (await resolveAccount(db, row.id)).id;
}

/** 支払額 amount の回の仕訳の行。利用額の分をカテゴリへ、残りを利息・手数料へ */
export async function paymentLines(db: D1Database, p: Installment, pay: Pick<Payment, "number">, amount: number): Promise<Line[]> {
  const base = Math.floor(p.principal / p.count);
  const principal = Math.min(pay.number === 1 ? p.principal - base * (p.count - 1) : base, amount);
  const category = (await resolveAccount(db, p.category_id)).id;
  const lines: Line[] = [{ account_id: category, amount: principal }];
  if (amount - principal > 0) lines.push({ account_id: await interestCategory(db), amount: amount - principal });
  lines.push({ account_id: p.card_id, amount: -amount });
  return lines.filter((l) => l.amount !== 0);
}

export function paymentMemo(p: Installment, n: number) {
  return [p.memo, `分割 ${n}/${p.count}回`].filter(Boolean).join(" ");
}

export function paymentFields(p: Installment, card: Card, pay: Payment): EntryFields {
  return {
    date: pay.date, report_date: pay.date, kind: "expense", payee: p.payee, memo: paymentMemo(p, pay.number),
    source: "installment", provisional: card.statement_import ? 1 : 0, billing_month: pay.month,
    auto_key: pay.key, category_source: "user", user_id: p.user_id,
  };
}

export async function getInstallment(db: D1Database, id: number): Promise<Installment> {
  const p = await db.prepare("SELECT * FROM installments WHERE id = ?").bind(id).first<Installment>();
  if (!p) throw new LedgerError("分割払いが見つかりません", 404);
  return p;
}

/** 分割払いの記録済みの回 */
export async function recordedPayments(db: D1Database, id: number) {
  const { results } = await db
    .prepare("SELECT * FROM entries WHERE auto_key LIKE ? ORDER BY date, id")
    .bind(`installment:${id}:%`)
    .all<Entry>();
  return results.map((e) => ({ entry: e, number: parseInstallmentKey(e.auto_key)!.number }));
}

/** 中身を確かめる。カードとカテゴリ、回数、金額 */
export async function validateInstallment(db: D1Database, p: Installment): Promise<Account> {
  const card = await getAccount(db, p.card_id);
  if (card.kind !== "card") throw new LedgerError("分割払いはカードで払ったときだけにできます");
  if (!card.closing_day || !card.payment_day) throw new LedgerError(`${card.name}の締め日と引き落とし日を設定してください`);
  const category = await resolveAccount(db, p.category_id);
  if (category.type !== "expense") throw new LedgerError("支出のカテゴリを選んでください");
  if (!Number.isInteger(p.count) || p.count < 2 || p.count > 99) throw new LedgerError("支払回数は2回から99回で入れてください");
  for (const [v, what] of [[p.principal, "利用額"], [p.first_payment, "1回目の支払額"], [p.payment, "毎月の支払額"]] as const) {
    if (!Number.isInteger(v) || v <= 0) throw new LedgerError(`${what}を円単位で入れてください`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.purchase_date)) throw new LedgerError("利用日を入れてください");
  if (!/^\d{4}-\d{2}$/.test(p.first_month)) throw new LedgerError("1回目の請求月は YYYY-MM で入れてください");
  if (!Number.isInteger(p.start_number) || p.start_number < 1 || p.start_number > p.count) p.start_number = 1;
  return card;
}

const COLS = ["card_id", "category_id", "payee", "memo", "purchase_date", "principal", "count", "first_month",
  "first_payment", "payment", "start_number", "origin", "user_id"] as const;

export async function insertInstallment(db: D1Database, p: Omit<Installment, "id">): Promise<Installment> {
  await validateInstallment(db, { ...p, id: 0 });
  return (await db
    .prepare(`INSERT INTO installments (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")}) RETURNING *`)
    .bind(...COLS.map((k) => p[k] ?? null))
    .first<Installment>())!;
}

export async function saveInstallment(db: D1Database, p: Installment) {
  await validateInstallment(db, p);
  await db.prepare(`UPDATE installments SET ${COLS.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...COLS.map((k) => p[k] ?? null), p.id).run();
}

/**
 * 今日までに請求に載った回を記録する。since を渡すとその日より前の回は飛ばす。
 * 毎日の処理では、消した回を作り直さないよう前月からだけを見る。
 */
export async function recordPlan(db: D1Database, p: Installment, today = todayJST(), since?: string): Promise<number[]> {
  const card = await getAccount(db, p.card_id);
  const done = new Set((await recordedPayments(db, p.id)).map((r) => r.number));
  const created: number[] = [];
  for (const pay of schedule(p, card)) {
    if (pay.number < p.start_number || pay.date > today || (since && pay.date < since) || done.has(pay.number)) continue;
    created.push(await createEntry(db, paymentFields(p, card, pay), await paymentLines(db, p, pay, pay.amount)));
  }
  return created;
}

export async function recordInstallments(db: D1Database, today = todayJST()) {
  const { results } = await db.prepare("SELECT * FROM installments").all<Installment>();
  const since = `${addMonths(monthOf(today), -1)}-01`;
  const created: number[] = [];
  for (const p of results) {
    try {
      created.push(...await recordPlan(db, p, today, since));
    } catch (e) {
      console.error(`分割払い ${p.id} を記録できませんでした`, e);
    }
  }
  return created;
}

/**
 * 分割の中身を変えたあと、記録済みの回を合わせる。明細で確かめた回は金額と日付を明細のまま残す。
 * 回数を減らしたり、途中から始めることにしたりして要らなくなった回は消す。
 */
export async function resyncPlan(db: D1Database, p: Installment, today = todayJST(), opts: {
  /** 明細の取り込みの中で使うとき。消したり新しく記録したりせず、書き換える前に控えを取らせる */
  before?: (entryId: number) => Promise<void>; skip?: number;
} = {}) {
  const card = await getAccount(db, p.card_id);
  const plan = new Map(schedule(p, card).map((x) => [x.number, x]));
  for (const { entry, number } of await recordedPayments(db, p.id)) {
    if (number === opts.skip) continue;
    const pay = plan.get(number);
    const confirmed = entry.statement_import_id !== null && entry.provisional === 0;
    if (!pay || number < p.start_number) {
      if (!confirmed && !opts.before) await deleteEntry(db, entry.id);
      continue;
    }
    await opts.before?.(entry.id);
    if (confirmed) {
      const { lines } = await getEntry(db, entry.id);
      const amount = -lines.filter((l) => l.account_id === p.card_id).reduce((s, l) => s + l.amount, 0);
      await updateEntry(db, entry.id, { payee: p.payee }, await paymentLines(db, p, pay, amount), "分割の変更");
      continue;
    }
    const f = paymentFields(p, card, pay);
    await updateEntry(db, entry.id, {
      date: f.date, report_date: f.report_date, payee: f.payee, memo: f.memo, billing_month: f.billing_month,
    }, await paymentLines(db, p, pay, pay.amount), "分割の変更");
  }
  if (!opts.before) await recordPlan(db, p, today);
}

/** 分割をやめる。明細で確かめていない回の記録も消す */
export async function deleteInstallment(db: D1Database, id: number) {
  await getInstallment(db, id);
  for (const { entry } of await recordedPayments(db, id)) {
    if (entry.statement_import_id !== null && entry.provisional === 0) continue;
    // 予定から記録した取引をあとから分割にしたときは、予定が取引を指しているので先に消す
    await db.prepare("DELETE FROM planned WHERE entry_id = ?").bind(entry.id).run();
    await deleteEntry(db, entry.id);
  }
  await db.prepare("DELETE FROM installments WHERE id = ?").bind(id).run();
}

/** まだ記録していない回。カードや請求月、記録する日の範囲で絞る */
export async function pendingPayments(db: D1Database, filter: { cardId?: number; month?: string; from?: string; to?: string } = {}) {
  const { results: plans } = await db
    .prepare(`SELECT * FROM installments ${filter.cardId ? "WHERE card_id = ?" : ""}`)
    .bind(...(filter.cardId ? [filter.cardId] : []))
    .all<Installment>();
  if (plans.length === 0) return [];
  const { results: cards } = await db.prepare("SELECT * FROM accounts WHERE kind = 'card'").all<Account>();
  const { results: keys } = await db
    .prepare("SELECT auto_key FROM entries WHERE auto_key LIKE 'installment:%'").all<{ auto_key: string }>();
  const done = new Set(keys.map((k) => k.auto_key));
  const out: (Payment & { plan: Installment })[] = [];
  for (const p of plans) {
    const card = cards.find((c) => c.id === p.card_id);
    if (!card || card.archived) continue;
    for (const pay of schedule(p, card)) {
      if (pay.number < p.start_number || done.has(pay.key)) continue;
      if (filter.month && pay.month !== filter.month) continue;
      if (filter.from && pay.date < filter.from) continue;
      if (filter.to && pay.date > filter.to) continue;
      out.push({ ...pay, plan: p });
    }
  }
  return out;
}

/** 記録のときに分割にする。1回目の請求月は利用日から決める */
export async function createInstallment(db: D1Database, input: {
  card_id: number; category_id: number; payee?: string; memo?: string; date: string; amount: number;
  count: number; fee?: number; user_id?: string | null;
}, today = todayJST()) {
  const card = await getAccount(db, input.card_id);
  if (card.kind !== "card") throw new LedgerError("分割払いはカードで払ったときだけにできます");
  if (!card.closing_day || !card.payment_day) throw new LedgerError(`${card.name}の締め日と引き落とし日を設定してください`);
  const fee = input.fee ?? 0;
  if (!Number.isInteger(fee) || fee < 0) throw new LedgerError("手数料は円単位で入れてください");
  const p = await insertInstallment(db, {
    card_id: card.id, category_id: input.category_id, payee: input.payee ?? "", memo: input.memo ?? "",
    purchase_date: input.date, principal: input.amount, count: input.count,
    first_month: billingMonth(input.date, card.closing_day, card.payment_day),
    ...defaultPayments(input.amount, input.count, fee),
    start_number: 1, origin: "manual", user_id: input.user_id ?? null,
  });
  await recordPlan(db, p, today);
  return p;
}

/**
 * あとから分割。カードで払った支出1件を分割払いにする。
 * もとの取引は1回目の支払いに変わる。明細から取り込んだ取引なら明細の鍵を残し、同じ明細を取り込み直しても二重にしない。
 */
export async function convertToInstallment(db: D1Database, entryId: number, input: {
  count: number; fee?: number; first_month?: string;
}, today = todayJST()) {
  const { entry, lines } = await getEntry(db, entryId);
  if (entry.kind !== "expense") throw new LedgerError("分割にできるのは支出だけです");
  if (parseInstallmentKey(entry.auto_key)) throw new LedgerError("この取引はもう分割払いです");
  const cardLines = lines.filter((l) => l.amount < 0);
  if (cardLines.length !== 1) throw new LedgerError("支払方法が1つの支出だけ分割にできます");
  const card = await getAccount(db, cardLines[0].account_id);
  if (card.kind !== "card") throw new LedgerError("カードで払った支出だけ分割にできます");
  if (!card.closing_day || !card.payment_day) throw new LedgerError(`${card.name}の締め日と引き落とし日を設定してください`);
  const categories = lines.filter((l) => l.amount > 0);
  if (categories.length !== 1) throw new LedgerError("カテゴリを1つにしてから分割にしてください");
  if (entry.advance) throw new LedgerError("立て替えのある支出は分割にできません");
  const fee = input.fee ?? 0;
  if (!Number.isInteger(fee) || fee < 0) throw new LedgerError("手数料は円単位で入れてください");
  const principal = -cardLines[0].amount;
  const p = await insertInstallment(db, {
    card_id: card.id, category_id: categories[0].account_id, payee: entry.payee, memo: entry.memo,
    purchase_date: entry.date, principal, count: input.count,
    first_month: input.first_month ?? entry.billing_month ?? billingMonth(entry.date, card.closing_day, card.payment_day),
    ...defaultPayments(principal, input.count, fee),
    start_number: 1, origin: "later", user_id: entry.user_id,
  });
  const first = schedule(p, card)[0];
  const f = paymentFields(p, card, first);
  // 取り込んだ明細の請求額から、分割にした分を外す。1回目がその請求月なら1回目の額だけ残す
  if (entry.statement_import_id !== null && entry.provisional === 0) {
    await db.prepare("UPDATE statement_imports SET imported_total = imported_total - ? WHERE id = ?")
      .bind(principal - (first.month === entry.billing_month ? first.amount : 0), entry.statement_import_id).run();
  }
  await updateEntry(db, entry.id, {
    date: f.date, report_date: f.report_date, memo: f.memo, billing_month: f.billing_month, auto_key: f.auto_key,
    source: "installment", provisional: f.provisional, category_source: entry.category_source,
  }, await paymentLines(db, p, first, first.amount), "あとから分割");
  await recordPlan(db, p, today);
  return p;
}
