// 来月の予算。繰り返し、カードの引き落とし、借入の返済、記録済みの臨時の支出を混ぜて、
// 来月末の手元資金から余裕を引いた額を確かめる。今日は固定して、時計に左右されないようにする。

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { nextMonthBudget } from "../src/lib/budget";
import { calendarMonth } from "../src/lib/calendar";
import { recordRecurring } from "../src/lib/recurring";
import { recordDuePayments } from "../src/lib/reports";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;
const db = testEnv.DB;
const today = "2026-10-29";

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

let bank: number, card: number, loan: number;

beforeAll(async () => {
  bank = (await api("POST", "/api/accounts", { name: "予算銀行", type: "asset", kind: "bank" })).id;
  card = (await api("POST", "/api/accounts", {
    name: "予算カード", type: "liability", kind: "card", closing_day: 15, payment_day: 10, payment_account_id: bank,
  })).id;
  loan = (await api("POST", "/api/accounts", {
    name: "予算奨学金", type: "liability", kind: "loan", payment_day: 27, payment_account_id: bank, payment_amount: 15000,
  })).id;

  await api("POST", "/api/opening", {
    date: "2026-10-01",
    balances: [{ account_id: bank, amount: 300000 }, { account_id: loan, amount: 500000 }],
  });

  // 10/10 の利用は 11/10 に落ちる
  await api("POST", "/api/entries", {
    kind: "expense", date: "2026-10-10", amount: 45000, from_account_id: card,
    category_id: await category("その他"), payee: "Amazon",
  });
  // 来月に記録済みの臨時の支出
  await api("POST", "/api/entries", {
    kind: "expense", date: "2026-11-05", amount: 5000, from_account_id: bank,
    category_id: await category("その他"), payee: "病院",
  });

  await api("POST", "/api/recurring", {
    kind: "income", amount: 250000, day: 25, first_date: "2026-11-25", to_account_id: bank,
    category_id: await category("給与"), payee: "給与",
  });
  await api("POST", "/api/recurring", {
    kind: "expense", amount: 80000, day: 1, first_date: "2026-11-01", from_account_id: bank,
    category_id: await category("その他"), payee: "家賃",
  });
  // カードで払う固定費。手元からは12月に出るので、来月使える額からは引かない
  await api("POST", "/api/recurring", {
    kind: "expense", amount: 8000, day: 10, first_date: "2026-11-10", from_account_id: card,
    category_id: await category("通信"), payee: "携帯",
  });

  // 10月分の返済を済ませておく
  await recordDuePayments(db, "2026-10-27");
  await api("PUT", "/api/settings", { budget_buffer: 30000 });
});

describe("来月の予算", () => {
  it("繰り返しと引き落としを読み、来月末の手元から余裕を引く", async () => {
    const b = await nextMonthBudget(db, today);

    expect(b.month).toBe("2026-11");
    expect(b.opening_liquid).toBe(285000);
    expect(b.income).toHaveLength(1);
    expect(b.income[0]).toMatchObject({ date: "2026-11-25", label: "給与", amount: 250000 });
    expect(b.expenses.reduce((s, x) => s + x.amount, 0)).toBe(145000);
    expect(b.expenses.map((x) => x.label)).toEqual(expect.arrayContaining(["家賃", "予算カード 引き落とし", "予算奨学金 返済", "病院"]));
    // カードで払う携帯は、来月の手元からは出ないので使える額から引かない
    expect(b.card_fixed).toHaveLength(1);
    expect(b.card_fixed[0]).toMatchObject({ label: "携帯", amount: 8000, cash_delta: 0 });
    expect(b.projected_liquid).toBe(390000);
    expect(b.card_unpaid).toBe(8000);
    expect(b.buffer).toBe(30000);
    expect(b.budget).toBe(360000);
  });

  it("回収していない立て替えは、来月の収入の見込みに含める", async () => {
    const before = await nextMonthBudget(db, today);
    const { id } = await api("POST", "/api/entries", {
      kind: "expense", date: "2026-10-20", amount: 6000, from_account_id: bank,
      category_id: await category("その他"), payee: "飲み会", advance: true,
    });
    await api("POST", `/api/entries/${id}/recoveries`, { date: "2026-10-21", account_id: bank, amount: 2000 });
    const b = await nextMonthBudget(db, today);

    expect(b.income).toContainEqual(expect.objectContaining({ date: "2026-11-01", label: "飲み会 の回収", amount: 4000 }));
    // 立て替えた6000円が出て2000円が戻り、残り4000円が来月に戻る見込み
    expect(b.budget).toBe(before.budget);
    // カレンダーのこれからの予定にも同じ見込みを出す
    expect((await calendarMonth(db, "2026-11", today)).planned)
      .toContainEqual(expect.objectContaining({ date: "2026-11-01", label: "飲み会 の回収", amount: 4000, kind: "income" }));
    await api("POST", `/api/entries/${id}/settle`, {});
    expect((await nextMonthBudget(db, today)).budget).toBe(before.budget - 4000);
    await api("DELETE", `/api/entries/${id}`);
  });

  it("すでに記録した回は、繰り返しから二重に足さない", async () => {
    await recordRecurring(db, "2026-11-25");
    const b = await nextMonthBudget(db, today);

    expect(b.income.filter((x) => x.label === "給与")).toHaveLength(1);
    expect(b.expenses.filter((x) => x.label === "家賃")).toHaveLength(1);
    expect(b.budget).toBe(360000);
  });

  it("来月にカードで使った分は、引き落としが再来月なら使える額から引かない", async () => {
    const before = await nextMonthBudget(db, today);
    await api("POST", "/api/entries", {
      kind: "expense", date: "2026-11-20", amount: 12000, from_account_id: card,
      category_id: await category("その他"), payee: "家電",
    });
    const b = await nextMonthBudget(db, today);
    // 11/20 の利用は1月に落ちるので、来月末の手元は変わらない
    expect(b.projected_liquid).toBe(before.projected_liquid);
    expect(b.card_unpaid).toBe(before.card_unpaid + 12000);
    expect(b.budget).toBe(before.budget);
  });

  it("カードで払う繰り返しは、来月に引き落とされるなら引き落とし額に入れて引く", async () => {
    // 10日締め27日払いのカード。11/10 の家賃は 11/27 に落ちる
    const rentCard = (await api("POST", "/api/accounts", {
      name: "家賃カード", type: "liability", kind: "card", closing_day: 10, payment_day: 27, payment_account_id: bank,
    })).id;
    const before = await nextMonthBudget(db, today);
    await api("POST", "/api/recurring", {
      kind: "expense", amount: 70000, day: 10, first_date: "2026-11-10", from_account_id: rentCard,
      category_id: await category("その他"), payee: "カードの家賃",
    });
    const b = await nextMonthBudget(db, today);
    expect(b.expenses).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: "2026-11-27", label: "家賃カード 引き落とし", amount: 70000, cash_delta: -70000 }),
    ]));
    expect(b.budget).toBe(before.budget - 70000);
  });
});

describe("締め日をあとから入れたカード", () => {
  it("請求月のない利用に請求月を付け、その月の引き落としに入れる", async () => {
    const late = (await api("POST", "/api/accounts", { name: "締め日なしカード", type: "liability", kind: "card", payment_day: 27, payment_account_id: bank })).id;
    const e = await api("POST", "/api/entries", {
      kind: "expense", date: "2026-10-13", amount: 51100, from_account_id: late, category_id: await category("その他"), payee: "家賃",
    });
    expect((await api("GET", `/api/entries/${e.id}`)).billing_month).toBeNull();
    await api("PATCH", `/api/accounts/${late}`, { closing_day: 31 });
    expect((await api("GET", `/api/entries/${e.id}`)).billing_month).toBe("2026-11");
    const b = await nextMonthBudget(db, today);
    expect(b.expenses).toEqual(expect.arrayContaining([expect.objectContaining({ label: "締め日なしカード 引き落とし", amount: 51100 })]));
  });
});
