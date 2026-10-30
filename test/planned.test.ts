// 繰り返しでない一度きりの予定。自動では記録せず、その日が来たら確かめて記録にする。

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { nextMonthBudget } from "../src/lib/budget";
import { calendarMonth } from "../src/lib/calendar";
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

let bank: number, card: number, other: number, salary: number;

beforeAll(async () => {
  bank = (await api("POST", "/api/accounts", { name: "予定銀行", type: "asset", kind: "bank" })).id;
  card = (await api("POST", "/api/accounts", {
    name: "予定カード", type: "liability", kind: "card", closing_day: 31, payment_day: 26, payment_account_id: bank,
  })).id;
  const all = await api<any[]>("GET", "/api/accounts");
  other = all.find((a) => a.name === "その他" && a.type === "expense").id;
  salary = all.find((a) => a.name === "給与" && a.type === "income").id;
  await api("POST", "/api/opening", { date: "2031-01-01", balances: [{ account_id: bank, amount: 100000 }] });
});

describe("一度きりの予定", () => {
  it("予定は記録にならず、日が来たものだけ確かめる一覧に出る", async () => {
    const past = await api("POST", "/api/planned", { kind: "expense", amount: 20000, date: "2020-01-10", from_account_id: bank, category_id: other, payee: "車検" });
    const future = await api("POST", "/api/planned", { kind: "income", amount: 50000, date: "2099-01-10", to_account_id: bank, category_id: salary, payee: "賞与" });
    const due = await api<any[]>("GET", "/api/planned?due=1");
    expect(due.map((p) => p.id)).toContain(past.id);
    expect(due.map((p) => p.id)).not.toContain(future.id);
    expect((await api<any[]>("GET", "/api/planned")).map((p) => p.id)).toEqual(expect.arrayContaining([past.id, future.id]));
    expect(await db.prepare("SELECT 1 FROM entries WHERE auto_key LIKE 'planned:%'").first()).toBeNull();
  });

  it("確かめて記録すると、予定は一覧から消え、二度は記録できない", async () => {
    const p = await api("POST", "/api/planned", { kind: "expense", amount: 8000, date: "2020-02-01", from_account_id: bank, category_id: other, payee: "健診" });
    // 金額は確かめるときに直せる
    const { id } = await api("POST", "/api/entries", { kind: "expense", amount: 7500, date: "2020-02-01", from_account_id: bank, category_id: other, payee: "健診", planned_id: p.id });
    expect((await api("GET", `/api/entries/${id}`)).source).toBe("planned");
    expect((await api<any[]>("GET", "/api/planned")).map((x) => x.id)).not.toContain(p.id);
    const again = await call("POST", "/api/entries", { kind: "expense", amount: 7500, date: "2020-02-01", from_account_id: bank, category_id: other, planned_id: p.id });
    expect(again.status).toBe(400);
    // 記録した取引を消すと、予定もいっしょに消える
    await api("DELETE", `/api/entries/${id}`);
    expect(await db.prepare("SELECT 1 FROM planned WHERE id = ?").bind(p.id).first()).toBeNull();
  });

  it("記録できない中身の予定は入れられない", async () => {
    const res = await call("POST", "/api/planned", { kind: "expense", amount: 1000, date: "2031-03-01", category_id: other });
    expect(res.status).toBe(400);
  });

  it("予定はやめられる", async () => {
    const p = await api("POST", "/api/planned", { kind: "expense", amount: 3000, date: "2031-03-05", from_account_id: bank, category_id: other });
    await api("PUT", `/api/planned/${p.id}`, { amount: 3500 });
    expect((await api("GET", `/api/planned/${p.id}`)).amount).toBe(3500);
    await api("DELETE", `/api/planned/${p.id}`);
    expect((await call("GET", `/api/planned/${p.id}`)).status).toBe(404);
  });

  it("カレンダーと来月使える額に入る", async () => {
    const cash = await api("POST", "/api/planned", { kind: "expense", amount: 40000, date: "2031-02-14", from_account_id: bank, category_id: other, payee: "旅行" });
    const byCard = await api("POST", "/api/planned", { kind: "expense", amount: 12000, date: "2031-02-20", from_account_id: card, category_id: other, payee: "家電" });

    const cal = await calendarMonth(db, "2031-02", "2031-01-15");
    expect(cal.planned).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: "2031-02-14", label: "旅行", amount: 40000, planned_id: cash.id }),
      expect.objectContaining({ date: "2031-02-20", label: "家電", planned_id: byCard.id }),
    ]));

    const b = await nextMonthBudget(db, "2031-01-15");
    expect(b.expenses).toEqual(expect.arrayContaining([expect.objectContaining({ label: "旅行", cash_delta: -40000 })]));
    // カードで払う予定は、手元からは3月に出るが、来月末の未払いとして引く
    expect(b.card_fixed).toEqual(expect.arrayContaining([expect.objectContaining({ label: "家電", cash_delta: 0 })]));
    expect(b.card_unpaid).toBeGreaterThanOrEqual(12000);
  });
});
