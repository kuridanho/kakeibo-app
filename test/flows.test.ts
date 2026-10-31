// お金の流れごとに、口座の残高、使えるお金、月の集計、カレンダーがそろって正しく動くかを確かめる。
// api.test.ts とは別の口座を作り、2027年の日付だけを使う。どの流れのあとも、複式簿記の釣り合いを確かめる。

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { calendarMonth } from "../src/lib/calendar";
import { addMonths, billingMonth, dayInMonth, nextBankDay, todayJST } from "../src/lib/dates";
import { recordRecurring } from "../src/lib/recurring";
import { loanOverview } from "../src/lib/interest";
import { cardDue, recordDuePayments } from "../src/lib/reports";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;
const db = testEnv.DB;

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json", "cf-access-authenticated-user-email": "me@example.com" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv);
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

async function category(name: string): Promise<number> {
  const all = await api<any[]>("GET", "/api/accounts");
  return all.find((a) => a.name === name && (a.type === "expense" || a.type === "income")).id;
}

async function snapshot() {
  const b = await api("GET", "/api/balances");
  const bal = (id: number) => b.accounts.find((a: any) => a.id === id).balance as number;
  return { b, bal };
}

const month = async (m: string) => api("GET", `/api/summary/month?month=${m}`);

/** どの仕訳も借方と貸方が釣り合い、純資産が開始残高と収入と支出から説明できる */
async function balanced() {
  const bad = await db.prepare("SELECT entry_id, SUM(amount) AS s FROM lines GROUP BY entry_id HAVING s != 0").all();
  expect(bad.results).toEqual([]);
  const { results } = await db
    .prepare("SELECT a.type, SUM(l.amount) AS s FROM lines l JOIN accounts a ON a.id = l.account_id GROUP BY a.type")
    .all<{ type: string; s: number }>();
  const sum = (t: string) => results.find((r) => r.type === t)?.s ?? 0;
  const b = await api("GET", "/api/balances");
  // 資産 − 負債 = 純資産(貸方) + 収入(貸方) − 支出(借方)
  expect(b.net_worth).toBe(-sum("equity") - sum("income") - sum("expense"));
}

let bank: number, wallet: number, paypay: number, card: number, loan: number;

beforeAll(async () => {
  bank = (await api("POST", "/api/accounts", { name: "流れ銀行", type: "asset", kind: "bank" })).id;
  wallet = (await api("POST", "/api/accounts", { name: "流れ財布", type: "asset", kind: "cash" })).id;
  paypay = (await api("POST", "/api/accounts", { name: "流れPayPay", type: "asset", kind: "emoney" })).id;
  card = (await api("POST", "/api/accounts", {
    name: "流れカード", type: "liability", kind: "card", closing_day: 15, payment_day: 10, payment_account_id: bank,
    statement_card_name: "流れカード",
  })).id;
  loan = (await api("POST", "/api/accounts", {
    name: "流れ奨学金", type: "liability", kind: "loan", payment_day: 27, payment_account_id: bank, payment_amount: 10000,
  })).id;
  await api("POST", "/api/opening", {
    date: "2027-01-01",
    balances: [
      { account_id: bank, amount: 200000 },
      { account_id: wallet, amount: 10000 },
      { account_id: paypay, amount: 5000 },
      { account_id: loan, amount: 500000 },
    ],
  });
});

describe("カレンダーの符号と集計", () => {
  it("予定の収入は入る額として、引き落としと返済は出る額として返す", async () => {
    const scholarship = await category("その他の収入");
    await api("POST", "/api/recurring", {
      kind: "income", amount: 94503, day: 9, first_date: "2027-11-09", to_account_id: bank, category_id: scholarship, payee: "奨学金",
    });
    await api("POST", "/api/recurring", {
      kind: "income", amount: 30000, day: 26, first_date: "2027-11-26", to_account_id: bank, category_id: scholarship, payee: "仕送り",
    });
    const cal = await calendarMonth(db, "2027-11", "2027-10-29");
    const p = (label: string) => cal.planned.find((x) => x.label === label)!;
    expect(p("奨学金")).toMatchObject({ date: "2027-11-09", amount: 94503, kind: "income" });
    expect(p("仕送り")).toMatchObject({ date: "2027-11-26", amount: 30000, kind: "income" });
    expect(p("流れ奨学金 返済")).toMatchObject({ amount: 10000, kind: "payment" });
    // 予定は記録ではないので、月の収入と支出には入らない
    expect(Object.keys(cal.days)).toEqual([]);
    await db.prepare("DELETE FROM recurring").run();
  });

  it("記録した収入はその日の収入、支出はその日の支出になる", async () => {
    const salary = await category("給与");
    const food = await category("食料品");
    await api("POST", "/api/entries", { kind: "income", date: "2027-01-25", amount: 250000, to_account_id: bank, category_id: salary });
    await api("POST", "/api/entries", { kind: "expense", date: "2027-01-25", amount: 1200, from_account_id: wallet, category_id: food });
    const cal = await calendarMonth(db, "2027-01", "2027-01-31");
    expect(cal.days["2027-01-25"]).toEqual({ income: 250000, expense: 1200 });
    const s = await month("2027-01");
    expect(s.income).toBe(250000);
    expect(s.expense).toBe(1200);
    const { bal } = await snapshot();
    expect(bal(bank)).toBe(450000);
    expect(bal(wallet)).toBe(8800);
    await balanced();
  });
});

describe("振替", () => {
  it("口座の間で動かしても、収入と支出と手元の現金は変わらない", async () => {
    const before = await snapshot();
    const s0 = await month("2027-02");
    await api("POST", "/api/entries", { kind: "transfer", date: "2027-02-01", amount: 3000, from_account_id: bank, to_account_id: paypay });
    await api("POST", "/api/entries", { kind: "transfer", date: "2027-02-01", amount: 20000, from_account_id: bank, to_account_id: wallet });
    const after = await snapshot();
    expect(after.bal(bank)).toBe(before.bal(bank) - 23000);
    expect(after.bal(paypay)).toBe(before.bal(paypay) + 3000);
    expect(after.bal(wallet)).toBe(before.bal(wallet) + 20000);
    expect(after.b.liquid_total).toBe(before.b.liquid_total);
    const s = await month("2027-02");
    expect([s.income, s.expense]).toEqual([s0.income, s0.expense]);
    expect((await calendarMonth(db, "2027-02", "2027-02-28")).days["2027-02-01"]).toBeUndefined();
    await balanced();
  });
});

describe("カード払いの保留と引き落とし", () => {
  it("使った日に支出になり、銀行は引き落とし日まで減らさず、使えるお金から保留する", async () => {
    const dining = await category("外食");
    const before = await snapshot();
    // 15日締め翌10日払い。3/5 の利用は 3月締め、4月払い
    const { id } = await api("POST", "/api/entries", {
      kind: "expense", date: "2027-03-05", amount: 5000, from_account_id: card, category_id: dining, payee: "居酒屋",
    });
    expect((await api("GET", `/api/entries/${id}`)).billing_month).toBe("2027-04");
    const mid = await snapshot();
    expect(mid.bal(bank)).toBe(before.bal(bank));
    expect(mid.bal(card)).toBe(5000);
    expect(mid.b.available_cash).toBe(before.b.available_cash - 5000);
    expect((await month("2027-03")).categories.find((c: any) => c.id === dining).amount).toBe(5000);

    // カレンダーでは4月の引き落とし日の前に出る予定になる
    const due = nextBankDay(dayInMonth("2027-04", 10));
    const cal = await calendarMonth(db, "2027-04", "2027-04-01");
    expect(cal.planned.find((p) => p.label === "流れカード 引き落とし")).toMatchObject({ date: due, amount: 5000, kind: "payment" });

    expect(await recordDuePayments(db, due)).toHaveLength(1);
    const after = await snapshot();
    expect(after.bal(bank)).toBe(before.bal(bank) - 5000);
    expect(after.bal(card)).toBe(0);
    // 引き落としは振替なので、使えるお金も支出も変わらない
    expect(after.b.available_cash).toBe(mid.b.available_cash);
    expect((await month("2027-04")).expense).toBe(0);
    expect((await calendarMonth(db, "2027-04", "2027-04-30")).days[due]).toBeUndefined();
    await balanced();
  });

  it("明細を取り込んだ月は、照合できなかった仮の取引を除いた明細の額が落ちる", async () => {
    const other = await category("その他");
    // 4/20 と 4/25 の利用は 5月締め、6月払い
    await api("POST", "/api/entries", { kind: "expense", date: "2027-04-20", amount: 2000, from_account_id: card, category_id: other, payee: "本屋" });
    const stray = await api("POST", "/api/entries", { kind: "expense", date: "2027-04-25", amount: 777, from_account_id: card, category_id: other, payee: "どこか" });
    const csv = "様,1,流れカード\n2027/04/20,ホンヤ,2000,１,１,2000,\n2027/05/01,ＮＥＴＦＬＩＸ,1590,１,１,1590,\n,,,,,3590,\n";
    await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2027-06", text: csv, choices: {} });
    const before = await snapshot();
    expect(before.bal(card)).toBe(2000 + 777 + 1590);
    const due = nextBankDay(dayInMonth("2027-06", 10));
    expect((await calendarMonth(db, "2027-06", "2027-06-01")).planned.find((p) => p.kind === "payment" && p.label.startsWith("流れカード"))?.amount).toBe(3590);
    await recordDuePayments(db, due);
    const after = await snapshot();
    expect(after.bal(bank)).toBe(before.bal(bank) - 3590);
    // 明細になかった分はカードの未払いに残り、仮のまま照合を待つ
    expect(after.bal(card)).toBe(777);
    expect((await api("GET", `/api/entries/${stray.id}`)).provisional).toBe(1);
    await balanced();
  });

  it("分割払いは毎月の支払額がその請求月の支出と引き落としになる", async () => {
    const shop = await category("買い物");
    const text = (n: number) => `様,1,流れカード\n2027/06/20,ヨドバシカメラ,30000,３,${"１２３"[n - 1]},10000,\n,,,,,10000,\n`;
    for (const [n, m] of [[1, "2027-08"], [2, "2027-09"], [3, "2027-10"]] as const) {
      await api("POST", "/api/statements/commit", { account_id: card, billing_month: m, text: text(n), choices: { 0: { category_id: shop } } });
    }
    const rows = await api<any[]>("GET", "/api/entries?q=ヨドバシ");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.billing_month).sort()).toEqual(["2027-08", "2027-09", "2027-10"]);
    const bankBefore = (await snapshot()).bal(bank);
    for (const m of ["2027-08", "2027-09", "2027-10"]) await recordDuePayments(db, nextBankDay(dayInMonth(m, 10)));
    const after = await snapshot();
    expect(after.bal(bank)).toBe(bankBefore - 30000);
    expect(after.bal(card)).toBe(777);
    await balanced();
  });
});

describe("借入の返済", () => {
  it("返済は元金を振替にし、利息を分けると利息だけが支出になる", async () => {
    const interest = await category("利息・手数料");
    const before = await snapshot();
    const due = nextBankDay("2027-01-27");
    const [id] = await recordDuePayments(db, due);
    expect(id).toBeDefined();
    let mid = await snapshot();
    expect(mid.bal(loan)).toBe(500000 - 10000);
    expect(mid.bal(bank)).toBe(before.bal(bank) - 10000);
    expect((await month("2027-01")).categories.find((c: any) => c.id === interest)).toBeUndefined();

    // 引き落とされた 10,000 円のうち 300 円が利息だったと直す
    await api("PUT", `/api/entries/${id}`, {
      kind: "transfer", date: due, amount: 10000, from_account_id: bank, to_account_id: loan, interest: 300,
    });
    mid = await snapshot();
    expect(mid.bal(loan)).toBe(500000 - 9700);
    expect(mid.bal(bank)).toBe(before.bal(bank) - 10000);
    expect((await month("2027-01")).categories.find((c: any) => c.id === interest).amount).toBe(300);
    expect((await calendarMonth(db, "2027-01", "2027-01-31")).days[due]).toEqual({ expense: 300, income: 0 });
    await balanced();
  });

  it("利息は借入への振替でしか分けられない", async () => {
    await expect(api("POST", "/api/entries", {
      kind: "transfer", date: "2027-01-28", amount: 1000, from_account_id: bank, to_account_id: wallet, interest: 100,
    })).rejects.toThrow("借入");
    await expect(api("POST", "/api/entries", {
      kind: "transfer", date: "2027-01-28", amount: 1000, from_account_id: bank, to_account_id: loan, interest: 1000,
    })).rejects.toThrow("400");
  });
});

describe("繰り返し", () => {
  it("記録された収入と支出は、手入力と同じように残高と集計に入る", async () => {
    const salary = await category("給与");
    const sub = await category("サブスク");
    await api("POST", "/api/recurring", {
      kind: "income", amount: 100000, day: 15, first_date: "2027-11-15", to_account_id: bank, category_id: salary, payee: "流れ給与",
    });
    await api("POST", "/api/recurring", {
      kind: "expense", amount: 1490, day: 3, first_date: "2027-11-03", from_account_id: card, category_id: sub, payee: "流れサブスク",
    });
    const before = await snapshot();
    const s0 = await month("2027-11");
    await recordRecurring(db, "2027-11-15");
    const after = await snapshot();
    expect(after.bal(bank)).toBe(before.bal(bank) + 100000);
    expect(after.bal(card)).toBe(before.bal(card) + 1490);
    const s = await month("2027-11");
    expect(s.income - s0.income).toBe(100000);
    expect(s.expense - s0.expense).toBe(1490);
    // カードの繰り返しにも請求月が付き、引き落としに入る
    const subEntry = (await api<any[]>("GET", "/api/entries?q=流れサブスク"))[0];
    expect(subEntry.billing_month).toBe("2027-12");
    await db.prepare("DELETE FROM recurring").run();
    await balanced();
  });
});

describe("立て替えの回収", () => {
  it("回収は元の取引の日の支出を減らし、受け取った月とカレンダーの日には出ない", async () => {
    const dining = await category("外食");
    const { id } = await api("POST", "/api/entries", {
      kind: "expense", date: "2027-02-20", amount: 9000, from_account_id: wallet, category_id: dining, payee: "焼肉", advance: true,
    });
    const before = await snapshot();
    await api("POST", `/api/entries/${id}/recoveries`, { date: "2027-03-02", account_id: paypay, amount: 3000 });
    const after = await snapshot();
    expect(after.bal(paypay)).toBe(before.bal(paypay) + 3000);
    expect((await month("2027-02")).categories.find((c: any) => c.id === dining).amount).toBe(6000);
    expect((await calendarMonth(db, "2027-02", "2027-02-28")).days["2027-02-20"].expense).toBe(6000);
    expect((await calendarMonth(db, "2027-03", "2027-03-31")).days["2027-03-02"]).toBeUndefined();
    await balanced();
  });
});

describe("棚卸し", () => {
  it("足りない分は使途不明の支出、多い分は使途不明を減らして残高を実際の額に合わせる", async () => {
    const unknown = await category("使途不明");
    const book = (await snapshot()).bal(paypay);
    await api("POST", "/api/balance-checks", { account_id: paypay, date: "2027-03-10", actual: book - 400, adjust: true });
    expect((await snapshot()).bal(paypay)).toBe(book - 400);
    expect((await month("2027-03")).categories.find((c: any) => c.id === unknown).amount).toBe(400);
    await api("POST", "/api/balance-checks", { account_id: paypay, date: "2027-03-20", actual: book - 100, adjust: true });
    expect((await snapshot()).bal(paypay)).toBe(book - 100);
    expect((await month("2027-03")).categories.find((c: any) => c.id === unknown).amount).toBe(100);
    await balanced();
  });
});

describe("品目ごとの支出の編集", () => {
  it("品目に分けた支出を品目のまま直すと、合計とカテゴリごとの額が保たれる", async () => {
    const food = await category("食料品");
    const shop = await category("買い物");
    const input = {
      kind: "expense", date: "2027-03-15", amount: 1500, from_account_id: wallet,
      items: [{ amount: 1000, category_id: food }, { amount: 500, category_id: shop }],
    };
    const { id } = await api("POST", "/api/entries", input);
    await api("PUT", `/api/entries/${id}`, { ...input, memo: "直した" });
    const e = await api("GET", `/api/entries/${id}`);
    expect(e.memo).toBe("直した");
    const byCat = Object.fromEntries(e.lines.map((l: any) => [l.account_id, l.amount]));
    expect(byCat).toEqual({ [food]: 1000, [shop]: 500, [wallet]: -1500 });
    await balanced();
  });
  it("締める前に取り込んだ明細の月は、そのあとの仮の取引も未確定として引き落としに足す", async () => {
    const other = await category("その他");
    // 取り込んだ今日の利用がまだこの請求月に入るので、明細は締める前の途中のもの
    const month = billingMonth(todayJST(), 15, 10);
    const used = dayInMonth(addMonths(month, -2), 16);
    const csv = `様,1,流れカード\n${used.replaceAll("-", "/")},ホンヤ,1200,１,１,1200,\n,,,,,1200,\n`;
    await api("POST", "/api/statements/commit", { account_id: card, billing_month: month, text: csv, choices: {} });
    await api("POST", "/api/entries", { kind: "expense", date: used, amount: 800, from_account_id: card, category_id: other, payee: "あとの利用" });
    const pay = (await calendarMonth(db, month, `${month}-01`)).planned.find((p) => p.label === "流れカード 引き落とし");
    expect(pay).toMatchObject({ amount: 2000, pending: 800 });
    // 実際の引き落としは明細の額のまま
    expect(await cardDue(db, card, month)).toBe(1200);
    await balanced();
  });
});

describe("同じ月の明細の取り込み直し", () => {
  it("前に取り込んだ行は重複として飛ばし、増えた行だけを足す。引き落とし額は新しい明細の合計になる", async () => {
    const first = "様,1,流れカード\n2027/11/20,ローソン,500,１,１,500,\n2027/11/21,ローソン,500,１,１,500,\n,,,,,1000,\n";
    const r1 = await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2028-01", text: first, choices: {} });
    expect(r1).toMatchObject({ created: 2, duplicate: 0 });
    const before = (await snapshot()).bal(card);
    // 同じ日に同じ店、同じ額の行が増えた明細。増えた1行と別の1行だけが入る
    const second = "様,1,流れカード\n2027/11/20,ローソン,500,１,１,500,\n2027/11/21,ローソン,500,１,１,500,\n2027/11/21,ローソン,500,１,１,500,\n2027/12/01,ＮＥＴＦＬＩＸ,1590,１,１,1590,\n,,,,,3090,\n";
    const preview = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2028-01", text: second });
    expect(preview.rows.map((x: any) => x.status)).toEqual(["duplicate", "duplicate", "new", "new"]);
    const r2 = await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2028-01", text: second, choices: {} });
    expect(r2).toMatchObject({ created: 2, duplicate: 2 });
    expect((await snapshot()).bal(card)).toBe(before + 500 + 1590);
    const due = nextBankDay(dayInMonth("2028-01", 10));
    expect((await calendarMonth(db, "2028-01", "2028-01-01")).planned.find((p) => p.label === "流れカード 引き落とし")?.amount).toBe(3090);
    await balanced();
  });
});

describe("13列の形式の明細の取り込み", () => {
  const wide = "2027/12/8,ミニストップ,ご本人,1回払い,,'28/02,500,500,,,,,\n2027/12/10,ＮＥＴＦＬＩＸ,ご本人,1回払い,,'28/02,990,,,6.00,USD,165.0,12/11\n";
  it("請求月が合えば取り込め、取り込み直すと重複になる", async () => {
    await expect(api("POST", "/api/statements/preview", { account_id: card, billing_month: "2028-01", text: wide })).rejects.toThrow("請求月");
    const r = await api("POST", "/api/statements/commit", { account_id: card, billing_month: "2028-02", text: wide, choices: {} });
    expect(r).toMatchObject({ created: 2, payment_total: 1490 });
    const again = await api("POST", "/api/statements/preview", { account_id: card, billing_month: "2028-02", text: wide });
    expect(again.rows.every((x: any) => x.status === "duplicate")).toBe(true);
    await balanced();
  });
});

describe("カードから電子マネーへのチャージ", () => {
  it("カードの請求に乗り、銀行からはカードの引き落とし日に出る", async () => {
    const debut = (await api("POST", "/api/accounts", {
      name: "流れチャージカード", type: "liability", kind: "card", closing_day: 31, payment_day: 26, payment_account_id: bank,
    })).id;
    const due = await api("GET", `/api/accounts/${debut}/due?date=2029-10-29`);
    expect(due).toEqual({ billing_month: "2029-11", date: nextBankDay("2029-11-26"), payment_account_id: bank });

    const before = await snapshot();
    const { id } = await api("POST", "/api/entries", { kind: "transfer", date: "2029-10-29", amount: 2000, from_account_id: debut, to_account_id: paypay });
    expect((await api("GET", `/api/entries/${id}`)).billing_month).toBe("2029-11");
    // チャージした日は、電子マネーが増えてカードの未払いが増えるだけで、銀行は動かない
    const after = await snapshot();
    expect(after.bal(paypay) - before.bal(paypay)).toBe(2000);
    expect(after.bal(bank)).toBe(before.bal(bank));

    expect(await recordDuePayments(db, "2029-11-25")).toHaveLength(0);
    const paid = await recordDuePayments(db, due.date);
    const entry = await api("GET", `/api/entries/${paid.find(Boolean)}`);
    expect(entry.date).toBe(due.date);
    expect(entry.lines.find((l: any) => l.account_id === bank).amount).toBe(-2000);
    await balanced();
  });

  it("カードでない口座は引き落とし日を返さない", async () => {
    expect((await api("GET", `/api/accounts/${bank}/due?date=2029-10-29`)).date).toBeNull();
  });
});

describe("年率のある借入(定額払い)", () => {
  it("締め日までの日割りの利息を返済額に含め、利息・手数料に分ける", async () => {
    const fixed = (await api("POST", "/api/accounts", {
      name: "流れ定額払い", type: "liability", kind: "loan", payment_day: 31, closing_day: 31, payment_account_id: bank,
      payment_amount: 2000, annual_rate: 18, pay_method: 1,
    })).id;
    await api("POST", "/api/entries", { date: "2027-09-17", kind: "expense", amount: 4500, category_id: await category("買い物"), from_account_id: fixed });
    const lines = async (m: string) => (await db.prepare(`SELECT l.account_id, l.amount FROM lines l JOIN entries e ON e.id = l.entry_id
      WHERE e.auto_key = ?`).bind(`payment:${fixed}:${m}`).all<{ account_id: number; amount: number }>()).results;
    const interestId = (await db.prepare("SELECT id FROM accounts WHERE seed_key = 'interest'").first<{ id: number }>())!.id;
    // 9月分は 9/18〜9/30 の13日。4500 × 18% × 13 / 365 = 28.8
    await recordDuePayments(db, "2027-11-01");
    expect(await lines("2027-10")).toEqual(expect.arrayContaining([
      { account_id: fixed, amount: 1972 }, { account_id: interestId, amount: 28 }, { account_id: bank, amount: -2000 },
    ]));
    // 10月分は 10/1〜10/31 の31日。4500 × 18% × 31 / 365 = 68.7
    await recordDuePayments(db, "2027-11-30");
    expect(await lines("2027-11")).toEqual(expect.arrayContaining([{ account_id: interestId, amount: 68 }]));
    await balanced();
  });

  it("先に引く残高があれば、その残高から引き、足りない分を引き落とし口座から引く", async () => {
    const merpay = (await api("POST", "/api/accounts", { name: "流れメルペイ", type: "asset", kind: "emoney" })).id;
    const fixed = (await api("POST", "/api/accounts", {
      name: "流れメルカード定額", type: "liability", kind: "loan", payment_day: 27, payment_account_id: bank,
      prepay_account_id: merpay, payment_amount: 3000,
    })).id;
    await api("POST", "/api/entries", { date: "2027-12-01", kind: "expense", amount: 9000, category_id: await category("買い物"), from_account_id: fixed });
    await api("POST", "/api/entries", { date: "2027-12-01", kind: "transfer", amount: 1200, from_account_id: bank, to_account_id: merpay });
    const lines = async (m: string) => (await db.prepare(`SELECT l.account_id, l.amount FROM lines l JOIN entries e ON e.id = l.entry_id
      WHERE e.auto_key = ?`).bind(`payment:${fixed}:${m}`).all<{ account_id: number; amount: number }>()).results;
    await recordDuePayments(db, nextBankDay(dayInMonth("2027-12", 27)));
    expect(await lines("2027-12")).toEqual(expect.arrayContaining([
      { account_id: fixed, amount: 3000 }, { account_id: merpay, amount: -1200 }, { account_id: bank, amount: -1800 },
    ]));
    const mid = await snapshot();
    expect(mid.bal(merpay)).toBe(0);
    expect(mid.bal(fixed)).toBe(6000);
    // 残高で足りる月は、引き落とし口座から引かない
    await api("POST", "/api/entries", { date: "2028-01-05", kind: "transfer", amount: 5000, from_account_id: bank, to_account_id: merpay });
    await recordDuePayments(db, nextBankDay(dayInMonth("2028-01", 27)));
    expect(await lines("2028-01")).toHaveLength(2);
    expect((await snapshot()).bal(merpay)).toBe(2000);
    await balanced();
  });

  it("借りた月は返さず、翌月の返済に前月の利息を含める(スマートマネー)", async () => {
    const smart = await api("POST", "/api/accounts", {
      name: "流れスマートマネー", type: "liability", kind: "loan", payment_day: 26, payment_account_id: bank,
      payment_amount: 10000, annual_rate: 12.1,
    });
    await api("POST", "/api/entries", { date: "2027-12-05", kind: "transfer", amount: 100000, from_account_id: smart.id, to_account_id: bank });
    const key = (m: string) => db.prepare("SELECT id FROM entries WHERE auto_key = ?").bind(`payment:${smart.id}:${m}`).first();
    await recordDuePayments(db, "2027-12-27");
    expect(await key("2027-12")).toBeNull();
    // 12/6〜12/31 の26日。100000 × 12.1% × 26 / 365 = 861.9
    const before = await loanOverview(db, smart, "2028-01-10");
    expect(before.next).toMatchObject({ date: "2028-01-26", amount: 10000, interest: 861 });
    expect(before.accrued.from).toBe("2028-01-01");
    expect(before.accrued.amount).toBe(Math.floor((100000 * 0.121 * 10) / 366));
    await recordDuePayments(db, "2028-01-26");
    expect(await key("2028-01")).not.toBeNull();
    expect((await loanOverview(db, smart, "2028-01-27")).paid_total).toBe(861);
    await balanced();
  });

  it("最初の返済日より前の月は返済を記録せず、次の返済はその日になる", async () => {
    const later = await api("POST", "/api/accounts", {
      name: "流れ後払い", type: "liability", kind: "loan", payment_day: 27, payment_account_id: bank,
      payment_amount: 3605, first_payment_date: "2028-03-27",
    });
    await api("POST", "/api/opening", { date: "2028-02-01", balances: [{ account_id: later.id, amount: 86540 }] });
    const key = (m: string) => db.prepare("SELECT id FROM entries WHERE auto_key = ?").bind(`payment:${later.id}:${m}`).first();
    await recordDuePayments(db, nextBankDay(dayInMonth("2028-02", 27)));
    expect(await key("2028-02")).toBeNull();
    expect((await loanOverview(db, later, "2028-02-28")).next).toMatchObject({ month: "2028-03", amount: 3605 });
    expect((await calendarMonth(db, "2028-02", "2028-02-01")).planned.find((p) => p.label === "流れ後払い 返済")).toBeUndefined();
    expect((await calendarMonth(db, "2028-03", "2028-03-01")).planned.find((p) => p.label === "流れ後払い 返済")).toBeDefined();
    await recordDuePayments(db, nextBankDay(dayInMonth("2028-03", 27)));
    expect(await key("2028-03")).not.toBeNull();
    await api("PATCH", `/api/accounts/${later.id}`, { first_payment_date: null });
    await balanced();
  });

  it("年率は0〜100の範囲で受け付ける", async () => {
    await expect(api("POST", "/api/accounts", { name: "流れ年率", type: "liability", kind: "loan", annual_rate: 120 })).rejects.toThrow();
  });
});
