// カードの分割払い。記録のときに分割にしたもの、あとから分割にしたもの、明細で見つけた分割を同じ形で持つ。
// 毎月の支払いは、その回が請求に載る日(締め日。1回目は利用日)に、その月の請求月の取引として記録する。
// まだ記録していない回は、カードの引き落とし額と来月使える額の見込みに足す。
// 利用額の全額は購入した日(使い始める前に買ったものは使い始めた日)にカテゴリの支出として記録し、
// 相手は「分割払い」(まだ請求に載っていない分割の利用額)にする。
// 毎月の回は、支払額のうち利用額を回数で割った分を「分割払い」からカードの請求へ移し、残りは利息・手数料の支出にする。
// 支払いを購入と混同しないよう、毎月の回はカテゴリの支出に数えない。

import type { Account, Entry, Line } from "../types";
import { addMonths, billingMonth, dayInMonth, monthOf, nextBankDay, todayJST } from "./dates";
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

/** 購入の取引の鍵。回の鍵と同じ installment: で始め、明細の照合や重複の候補から外れるようにする */
export const purchaseKey = (id: number) => `installment:${id}:purchase`;

/** 回の取引でも購入の取引でも、どの分割払いのものか。購入は number 0 */
export function installmentOf(key: string | null): { id: number; number: number } | null {
  const m = /^installment:(\d+):purchase$/.exec(key ?? "");
  return m ? { id: Number(m[1]), number: 0 } : parseInstallmentKey(key);
}

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

/** まだ請求に載っていない分割の利用額を数える勘定 */
async function deferredAccount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT id FROM accounts WHERE seed_key = 'installment_deferred'").first<{ id: number }>();
  if (!row) throw new LedgerError("分割払いの勘定がありません");
  return row.id;
}

/** 支払額 amount の回の仕訳の行。利用額の分を「分割払い」から移し、残りを利息・手数料の支出へ */
export async function paymentLines(db: D1Database, p: Installment, pay: Pick<Payment, "number">, amount: number): Promise<Line[]> {
  const base = Math.floor(p.principal / p.count);
  const principal = Math.min(pay.number === 1 ? p.principal - base * (p.count - 1) : base, amount);
  const lines: Line[] = [{ account_id: await deferredAccount(db), amount: principal }];
  if (amount - principal > 0) lines.push({ account_id: await interestCategory(db), amount: amount - principal });
  lines.push({ account_id: p.card_id, amount: -amount });
  return lines.filter((l) => l.amount !== 0);
}

export function paymentMemo(p: Installment, n: number) {
  return [p.memo, n === 0 ? `分割 ${p.count}回払いで購入` : `分割 ${n}/${p.count}回`].filter(Boolean).join(" ");
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
  return results.filter((e) => parseInstallmentKey(e.auto_key)).map((e) => ({ entry: e, number: parseInstallmentKey(e.auto_key)!.number }));
}

/**
 * 購入の取引を分割払いに合わせる。記録する回(start_number 以降)の利用額の全額を、購入した日のカテゴリの支出にする。
 * 使い始める前に買ったものは使い始めた日に記録する。メモは利用者が直したものを残す。
 */
export async function syncPurchase(db: D1Database, p: Installment, start?: string | null) {
  const card = await getAccount(db, p.card_id);
  const amount = schedule(p, card).filter((x) => x.number >= p.start_number).reduce((s, x) => s + x.principal, 0);
  if (start === undefined) start = await trackingStart(db);
  const date = start && p.purchase_date < start ? start : p.purchase_date;
  const lines: Line[] = [
    { account_id: (await resolveAccount(db, p.category_id)).id, amount },
    { account_id: await deferredAccount(db), amount: -amount },
  ];
  const key = purchaseKey(p.id);
  const existing = await db.prepare("SELECT * FROM entries WHERE auto_key = ?").bind(key).first<Entry>();
  if (!existing) {
    await createEntry(db, {
      date, report_date: date, kind: "expense", payee: p.payee, memo: paymentMemo(p, 0),
      source: "installment", provisional: 0, billing_month: null, auto_key: key, category_source: "user", user_id: p.user_id,
    }, lines);
    return;
  }
  const { lines: old } = await getEntry(db, existing.id);
  const same = old.length === lines.length && lines.every((l) => old.some((o) => o.account_id === l.account_id && o.amount === l.amount));
  if (same && existing.date === date && existing.report_date === date && existing.payee === p.payee) return;
  await updateEntry(db, existing.id, { date, report_date: date, payee: p.payee }, lines, "分割の変更");
}

/** すべての分割払いの購入の取引を合わせ、分割払いがなくなった購入の取引を消す */
export async function syncPurchases(db: D1Database) {
  const { results } = await db.prepare("SELECT * FROM installments").all<Installment>();
  const start = await trackingStart(db);
  for (const p of results) {
    try {
      await syncPurchase(db, p, start);
    } catch (e) {
      console.error(`分割払い ${p.id} の購入を合わせられませんでした`, e);
    }
  }
  const { results: orphans } = await db
    .prepare(`SELECT id FROM entries WHERE auto_key LIKE 'installment:%:purchase'
      AND CAST(substr(auto_key, 13, length(auto_key) - 21) AS INTEGER) NOT IN (SELECT id FROM installments)`)
    .all<{ id: number }>();
  for (const o of orphans) await deleteEntry(db, o.id);
}

/** 中身を確かめる。カードとカテゴリ、回数、金額 */
export async function validateInstallment(db: D1Database, p: Installment): Promise<Account> {
  const card = await getAccount(db, p.card_id);
  if (card.kind !== "card") throw new LedgerError("分割払いはクレジットカード払いのみ設定できます");
  if (!card.closing_day || !card.payment_day) throw new LedgerError(`${card.name}の締め日と引き落とし日を設定してください`);
  const category = await resolveAccount(db, p.category_id);
  if (category.type !== "expense") throw new LedgerError("支出のカテゴリを選択してください");
  if (!Number.isInteger(p.count) || p.count < 2 || p.count > 99) throw new LedgerError("支払回数は2〜99回の範囲で入力してください");
  for (const [v, what] of [[p.principal, "利用額"], [p.first_payment, "1回目の支払額"], [p.payment, "毎月の支払額"]] as const) {
    if (!Number.isInteger(v) || v <= 0) throw new LedgerError(`${what}は円単位で入力してください`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.purchase_date)) throw new LedgerError("利用日を入力してください");
  if (!/^\d{4}-\d{2}$/.test(p.first_month)) throw new LedgerError("1回目の請求月は「YYYY-MM」形式で入力してください");
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
  await syncPurchase(db, p);
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
  await syncPurchases(db);
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
  const p = await getInstallment(db, id);
  const deferred = await deferredAccount(db);
  const category = (await resolveAccount(db, p.category_id)).id;
  for (const { entry } of await recordedPayments(db, id)) {
    if (entry.statement_import_id !== null && entry.provisional === 0) {
      // 明細で確かめた回は残す。購入の取引がなくなるので、利用額の分をカテゴリの支出に戻す
      const { lines } = await getEntry(db, entry.id);
      await updateEntry(db, entry.id, {}, lines.map((l) => ({
        account_id: l.account_id === deferred ? category : l.account_id, amount: l.amount,
      })), "分割の解除");
      continue;
    }
    // 予定から記録した取引をあとから分割にしたときは、予定が取引を指しているので先に消す
    await db.prepare("DELETE FROM planned WHERE entry_id = ?").bind(entry.id).run();
    await deleteEntry(db, entry.id);
  }
  const purchase = await db.prepare("SELECT id FROM entries WHERE auto_key = ?").bind(purchaseKey(id)).first<{ id: number }>();
  if (purchase) await deleteEntry(db, purchase.id);
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

/** 使い始めた日。最初に入れた開始残高の日で、これより前の引き落としはもう手元の残高から引かれている */
export async function trackingStart(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT MIN(date) AS d FROM entries WHERE kind = 'opening'").first<{ d: string | null }>();
  return row?.d ?? null;
}

/**
 * 使い始める前に引き落とされた回を飛ばした、最初に記録する回。
 * 前の利用を分割で登録したとき、引き落とし済みの回をカードの未払いに残さないため
 */
export function firstUnpaidNumber(p: Pick<Installment, "count" | "first_month">, card: Pick<Account, "payment_day">, start: string | null): number {
  if (!start || !card.payment_day) return 1;
  for (let n = 1; n <= p.count; n++) {
    if (nextBankDay(dayInMonth(addMonths(p.first_month, n - 1), card.payment_day)) >= start) return n;
  }
  return p.count;
}

/** 記録のときに分割にする。1回目の請求月は利用日から決める */
export async function createInstallment(db: D1Database, input: {
  card_id: number; category_id: number; payee?: string; memo?: string; date: string; amount: number;
  count: number; fee?: number; user_id?: string | null;
}, today = todayJST()) {
  const card = await getAccount(db, input.card_id);
  if (card.kind !== "card") throw new LedgerError("分割払いはクレジットカード払いのみ設定できます");
  if (!card.closing_day || !card.payment_day) throw new LedgerError(`${card.name}の締め日と引き落とし日を設定してください`);
  const fee = input.fee ?? 0;
  if (!Number.isInteger(fee) || fee < 0) throw new LedgerError("手数料は円単位で入力してください");
  const first_month = billingMonth(input.date, card.closing_day, card.payment_day);
  const p = await insertInstallment(db, {
    card_id: card.id, category_id: input.category_id, payee: input.payee ?? "", memo: input.memo ?? "",
    purchase_date: input.date, principal: input.amount, count: input.count, first_month,
    ...defaultPayments(input.amount, input.count, fee),
    start_number: firstUnpaidNumber({ count: input.count, first_month }, card, await trackingStart(db)),
    origin: "manual", user_id: input.user_id ?? null,
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
  if (entry.kind !== "expense") throw new LedgerError("分割払いにできるのは支出のみです");
  if (installmentOf(entry.auto_key)) throw new LedgerError("この取引はすでに分割払いに設定されています");
  const cardLines = lines.filter((l) => l.amount < 0);
  if (cardLines.length !== 1) throw new LedgerError("支払方法が1つの支出のみ分割払いにできます");
  const card = await getAccount(db, cardLines[0].account_id);
  if (card.kind !== "card") throw new LedgerError("クレジットカード払いの支出のみ分割払いにできます");
  if (!card.closing_day || !card.payment_day) throw new LedgerError(`${card.name}の締め日と引き落とし日を設定してください`);
  const categories = lines.filter((l) => l.amount > 0);
  if (categories.length !== 1) throw new LedgerError("カテゴリを1つにしてから分割払いに設定してください");
  if (entry.advance) throw new LedgerError("立て替えのある支出は分割払いにできません");
  const fee = input.fee ?? 0;
  if (!Number.isInteger(fee) || fee < 0) throw new LedgerError("手数料は円単位で入力してください");
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
