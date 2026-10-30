// カードの分割払い。記録のときの分割、あとから分割、明細の分割の行との照合。

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { createInstallment, recordInstallments } from "../src/lib/installments";
import { nextMonthBudget } from "../src/lib/budget";
import { calendarMonth } from "../src/lib/calendar";
import { cardDue } from "../src/lib/reports";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;
const db = testEnv.DB;

async function call(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json", "cf-access-authenticated-user-email": "me@example.com" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv);
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(method, path, body);
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

let bank: number, shopping: number, interest: number;

async function newCard(name: string) {
  return (await api("POST", "/api/accounts", {
    name, type: "liability", kind: "card", closing_day: 31, payment_day: 26, payment_account_id: bank,
  })).id as number;
}

/** 取引の行を、カテゴリ、利息・手数料、カードの額にまとめる */
async function split(entryId: number, card: number) {
  const e = await api("GET", `/api/entries/${entryId}`);
  const sum = (id: number) => e.lines.filter((l: any) => l.account_id === id).reduce((s: number, l: any) => s + l.amount, 0);
  return { entry: e, category: sum(shopping), fee: sum(interest), card: -sum(card) };
}

const wideRow = (date: string, merchant: string, n: string, month: string, usage: number, payment: number) =>
  `${date},${merchant},ご本人,分割払い,'${n},'${month},${usage},${payment},,,,,`;

beforeAll(async () => {
  bank = (await api("POST", "/api/accounts", { name: "分割銀行", type: "asset", kind: "bank" })).id;
  const all = await api<any[]>("GET", "/api/accounts");
  shopping = all.find((a) => a.name === "買い物" && a.type === "expense").id;
  interest = all.find((a) => a.seed_key === "interest").id;
});

describe("分割払い", () => {
  it("記録のときに分割にすると、1回目だけ記録し、残りは請求に載る日に記録する", async () => {
    const card = await newCard("分割カードA");
    const p = await createInstallment(db, {
      card_id: card, category_id: shopping, payee: "家電店", date: "2030-03-10", amount: 100000, count: 3, fee: 1500,
    }, "2030-03-10");
    // 101,500円を3回。端数は1回目に寄せる
    expect([p.first_payment, p.payment]).toEqual([33834, 33833]);
    const plan = await api("GET", `/api/installments/${p.id}`);
    expect(plan.payments.map((x: any) => [x.month, x.date, x.amount])).toEqual([
      ["2030-04", "2030-03-10", 33834], ["2030-05", "2030-04-30", 33833], ["2030-06", "2030-05-31", 33833],
    ]);
    const first = plan.payments[0].entry_id;
    expect(plan.payments[1].entry_id).toBeNull();
    // 利用額を3回で割った分がカテゴリ、残りが利息・手数料
    const s = await split(first, card);
    expect(s).toMatchObject({ category: 33334, fee: 500, card: 33834 });
    expect(s.entry.billing_month).toBe("2030-04");
    expect(s.entry.memo).toBe("分割 1/3回");
    expect(s.entry.installment).toEqual({ id: p.id, number: 1, count: 3 });

    // まだ記録していない回も、その請求月の引き落とし額とカレンダーに入る
    expect(await cardDue(db, card, "2030-05")).toBe(33833);
    // カレンダーでは、請求に載る日ではなく引き落とし日に、引き落としの内訳として並ぶ
    const cal = await calendarMonth(db, "2030-05", "2030-03-10");
    const debit = cal.planned.find((x) => x.kind === "payment" && x.label.endsWith("引き落とし"))!;
    expect(cal.planned.find((x) => x.label === "家電店 2/3回")).toMatchObject({ date: debit.date, amount: 33833, kind: "card" });
    expect((await calendarMonth(db, "2030-04", "2030-03-10")).planned.find((x) => x.label === "家電店 2/3回")).toBeUndefined();

    // 来月使える額では、来月に請求に載る回をカードの未払いに入れる
    const budget = await nextMonthBudget(db, "2030-03-10");
    expect(budget.card_fixed.find((x) => x.label === "家電店 2/3回")).toMatchObject({ date: "2030-04-30", amount: 33833 });

    await recordInstallments(db, "2030-04-30");
    const second = (await api("GET", `/api/installments/${p.id}`)).payments[1];
    expect(second.entry_id).not.toBeNull();
    expect((await split(second.entry_id, card)).entry).toMatchObject({ date: "2030-04-30", billing_month: "2030-05" });
    expect(await cardDue(db, card, "2030-05")).toBe(33833);
  });

  it("記録の画面から支払回数を付けて入れられる", async () => {
    const card = await newCard("分割カードB");
    const r = await api("POST", "/api/entries", {
      kind: "expense", amount: 30000, date: "2026-01-05", from_account_id: card, category_id: shopping, payee: "眼鏡",
      installment_count: 3,
    });
    expect(r.installment_id).toBeTruthy();
    const list = await api<any[]>("GET", "/api/installments");
    const mine = list.find((x) => x.id === r.installment_id);
    // 今日までに請求に載った回はすべて記録してある
    expect(mine).toMatchObject({ recorded: 3, remaining: 0, done: true });
    const res = await call("POST", "/api/entries", {
      kind: "expense", amount: 30000, date: "2026-01-05", from_account_id: bank, category_id: shopping, installment_count: 3,
    });
    expect(res.status).toBe(400);
  });

  it("あとから分割にすると、もとの取引が1回目になり、明細の分割の行と結びつく", async () => {
    const card = await newCard("分割カードC");
    const { id } = await api("POST", "/api/entries", {
      kind: "expense", amount: 120000, date: "2030-06-05", from_account_id: card, category_id: shopping, payee: "パソコン",
    });
    const p = await api("POST", `/api/entries/${id}/installment`, { count: 12 });
    let s = await split(id, card);
    expect(s).toMatchObject({ category: 10000, fee: 0, card: 10000 });
    expect(s.entry).toMatchObject({ billing_month: "2030-07", provisional: 1, memo: "分割 1/12回" });
    expect(await cardDue(db, card, "2030-08")).toBe(10000);
    // 2回は分割にできない
    expect((await call("POST", `/api/entries/${id}/installment`, { count: 3 })).status).toBe(400);

    // 7月の明細。手数料の入った額で載る
    const july = wideRow("2030/6/5", "パソコンショップ", "1/12", "30/07", 120000, 10200);
    const pre = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2030-07", text: july });
    expect(pre.rows[0]).toMatchObject({ status: "matched", installment_id: p.id });
    expect(pre.leftovers).toEqual([]);
    const r1 = await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2030-07", text: july });
    expect(r1).toMatchObject({ linked: 1, created: 0 });
    s = await split(id, card);
    expect(s).toMatchObject({ category: 10000, fee: 200, card: 10200 });
    expect(s.entry).toMatchObject({ provisional: 0, source: "statement", date: "2030-06-05", payee: "パソコン" });

    // 8月の明細の2回目は、まだ記録していない回として新しく作る。以降の見込みはその額にする
    const aug = wideRow("2030/6/5", "パソコンショップ", "2/12", "30/08", 120000, 10100);
    const r2 = await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2030-08", text: aug });
    expect(r2).toMatchObject({ linked: 1, created: 0 });
    const plan = await api("GET", `/api/installments/${p.id}`);
    expect(plan.payments[1]).toMatchObject({ confirmed: true, amount: 10100, date: "2030-07-31" });
    expect(plan.payment).toBe(10100);
    expect(await cardDue(db, card, "2030-09")).toBe(10100);
    // 同じ明細は二度取り込まない
    const again = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2030-08", text: aug });
    expect(again.rows[0].status).toBe("duplicate");
  });

  it("取り込んだ明細の取引をあとから分割にすると、その請求額も分割の1回目の額にする", async () => {
    const card = await newCard("分割カードD");
    const text = "2030/2/1,テレビの店,ご本人,1回払い,,'30/03,90000,90000,,,,,\r\n2030/2/2,本屋,ご本人,1回払い,,'30/03,1000,1000,,,,,";
    await api("POST", "/api/statements/commit", {
      account_id: card, billing_month: "2030-03", text, choices: { 0: { category_id: shopping }, 1: { category_id: shopping } },
    });
    expect(await cardDue(db, card, "2030-03")).toBe(91000);
    const tv = (await api<any[]>("GET", `/api/entries?account_id=${card}`)).find((e) => e.payee === "テレビの店");
    await api("POST", `/api/entries/${tv.id}/installment`, { count: 6 });
    expect(await cardDue(db, card, "2030-03")).toBe(16000);
    expect(await cardDue(db, card, "2030-04")).toBe(15000);
  });

  it("手入力した1回払いが明細で分割になっていたら、分割払いとして登録する", async () => {
    const card = await newCard("分割カードE");
    const { id } = await api("POST", "/api/entries", {
      kind: "expense", amount: 60000, date: "2030-05-01", from_account_id: card, category_id: shopping, payee: "自転車",
    });
    const text = wideRow("2030/5/1", "サイクルショップ", "1/6", "30/06", 60000, 10000);
    const pre = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2030-06", text });
    expect(pre.rows[0]).toMatchObject({ status: "matched", match_entry_id: id });
    await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2030-06", text });
    const e = await api("GET", `/api/entries/${id}`);
    expect(e.installment).toMatchObject({ number: 1, count: 6 });
    expect(e.payee).toBe("自転車");
    expect(await cardDue(db, card, "2030-07")).toBe(10000);
  });

  it("手入力した全額の取引が、あとから分割の2回目の行と結びつき、もとの取引が1回目になる", async () => {
    const card = await newCard("分割カードH");
    const { id } = await api("POST", "/api/entries", {
      kind: "expense", amount: 4383, date: "2030-08-06", from_account_id: card, category_id: shopping, payee: "スーパー",
    });
    // あとから分割の行は、利用金額の列にもその回の支払額が入る
    const text = wideRow("2030/8/6", "ヨークベニマル 食品", "2/3", "30/10", 1461, 1461);
    const pre = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2030-10", text });
    expect(pre.rows[0]).toMatchObject({ status: "matched", match_entry_id: id });
    await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2030-10", text });
    const [plan] = (await api<any[]>("GET", "/api/installments")).filter((x) => x.card_id === card);
    expect(plan).toMatchObject({ count: 3, principal: 4383, start_number: 1, first_month: "2030-09", origin: "later", recorded: 2 });
    const e = await api("GET", `/api/entries/${id}`);
    expect(e).toMatchObject({ billing_month: "2030-09", installment: { number: 1 } });
    expect(await cardDue(db, card, "2030-09")).toBe(1461);
    expect(await cardDue(db, card, "2030-10")).toBe(1461);
    expect(await cardDue(db, card, "2030-11")).toBe(1461);
    // 同じ明細を取り込み直しても二重にしない
    const again = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2030-10", text });
    expect(again.rows[0].status).toBe("duplicate");
  });

  it("登録していない分割の行は分割払いとして登録し、前に取り込んだ同じ分割の回もまとめる", async () => {
    const card = await newCard("分割カードF");
    const oct = wideRow("2030/3/10", "アップルジャパン", "7/24", "30/10", 7241, 7241);
    await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2030-10", text: oct, choices: { 0: { category_id: shopping } } });
    // 以前の取り込みで作られた、分割払いに結びついていない取引のふりをする
    const old = await db.prepare("SELECT e.id FROM entries e JOIN lines l ON l.entry_id = e.id WHERE l.account_id = ?").bind(card).first<{ id: number }>();
    await db.prepare("UPDATE entries SET auto_key = NULL, date = '2030-03-10', report_date = '2030-03-10' WHERE id = ?").bind(old!.id).run();
    await db.prepare("DELETE FROM installments WHERE card_id = ?").bind(card).run();

    const nov = wideRow("2030/3/10", "アップルジャパン", "8/24", "30/11", 7241, 7241);
    const r = await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2030-11", text: nov, choices: { 0: { category_id: shopping } } });
    expect(r.created).toBe(1);
    const [plan] = (await api<any[]>("GET", "/api/installments")).filter((x) => x.card_id === card);
    expect(plan).toMatchObject({ count: 24, start_number: 7, first_month: "2030-04", origin: "statement", recorded: 2 });
    // 利用日ではなく、その回が請求に載った月の支出にする。引き落とし日も請求月から出す
    const adopted = await api("GET", `/api/entries/${old!.id}`);
    expect(adopted).toMatchObject({ date: "2030-09-30", billing_month: "2030-10", installment: { number: 7 } });
    expect(await api("GET", `/api/accounts/${card}/due?date=${adopted.date}&month=${adopted.billing_month}`))
      .toMatchObject({ billing_month: "2030-10", date: "2030-10-28" });
    expect(await cardDue(db, card, "2030-12")).toBe(7241);
    // 12月の明細は、登録した分割払いと結びつく
    const dec = wideRow("2030/3/10", "アップルジャパン", "9/24", "30/12", 7241, 7241);
    const pre = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2030-12", text: dec });
    expect(pre.rows[0]).toMatchObject({ status: "matched", installment_id: plan.id });
  });

  it("分割の回数を直すと記録済みの回を割り直し、やめると明細で確かめていない回を消す", async () => {
    const card = await newCard("分割カードG");
    const p = await createInstallment(db, {
      card_id: card, category_id: shopping, payee: "椅子", date: "2030-01-10", amount: 60000, count: 6,
    }, "2030-03-01");
    expect((await api("GET", `/api/installments/${p.id}`)).payments.filter((x: any) => x.entry_id).length).toBe(2);
    const next = await api("PUT", `/api/installments/${p.id}`, { count: 3 });
    expect([next.first_payment, next.payment]).toEqual([20000, 20000]);
    const plan = await api("GET", `/api/installments/${p.id}`);
    expect(plan.payments.map((x: any) => x.amount)).toEqual([20000, 20000, 20000]);
    expect((await split(plan.payments[0].entry_id, card)).card).toBe(20000);
    await api("DELETE", `/api/installments/${p.id}`);
    expect(await db.prepare("SELECT 1 FROM entries WHERE auto_key LIKE ?").bind(`installment:${p.id}:%`).first()).toBeNull();
  });
});
