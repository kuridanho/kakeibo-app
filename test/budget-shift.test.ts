// 引き落とし日が祝日で翌月にずれるとき、来月の予算にその回が入ることを確かめる。

import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { app } from "../src/index";
import { nextMonthBudget } from "../src/lib/budget";
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

let bank: number, card: number;

beforeAll(async () => {
  bank = (await api("POST", "/api/accounts", { name: "シフト銀行", type: "asset", kind: "bank" })).id;
  card = (await api("POST", "/api/accounts", {
    name: "シフトカード", type: "liability", kind: "card", closing_day: 31, payment_day: 31, payment_account_id: bank,
  })).id;
  await api("POST", "/api/opening", { date: "2027-01-01", balances: [{ account_id: bank, amount: 100000 }] });
  // 2026/12/20 の利用は 2027/1/31(日) に落ちる。翌営業日の 2/1 にずれる
  const other = (await api<any[]>("GET", "/api/accounts")).find((a) => a.name === "その他").id;
  await api("POST", "/api/entries", {
    kind: "expense", date: "2026-12-20", amount: 12000, from_account_id: card, category_id: other, payee: "年末の買い物",
  });
});

it("祝日で翌月にずれた引き落としを、翌月の予算に入れる", async () => {
  const b = await nextMonthBudget(db, "2027-01-29");

  expect(b.month).toBe("2027-02");
  expect(b.income).toEqual([]);
  expect(b.expenses).toHaveLength(1);
  expect(b.expenses[0]).toMatchObject({
    date: "2027-02-01",
    label: "シフトカード 引き落とし",
    amount: 12000,
    cash_delta: -12000,
  });
  expect(b.projected_liquid).toBe(88000);
  expect(b.budget).toBe(88000);
});
