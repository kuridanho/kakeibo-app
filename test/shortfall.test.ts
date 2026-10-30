// 引き落としの残高不足の警告は、引き落とし日が近づいたときだけ出す

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { balances, recordDuePayments, SHORTFALL_DAYS } from "../src/lib/reports";
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
  bank = (await api("POST", "/api/accounts", { name: "不足銀行", type: "asset", kind: "bank" })).id;
  // 月末締め、翌月26日払い。2030-11-26 は火曜
  card = (await api("POST", "/api/accounts", {
    name: "不足カード", type: "liability", kind: "card", closing_day: 31, payment_day: 26, payment_account_id: bank,
  })).id;
  await api("POST", "/api/opening", { date: "2030-10-01", balances: [{ account_id: bank, amount: 10000 }] });
  const all = await api<any[]>("GET", "/api/accounts");
  const other = all.find((a) => a.name === "その他" && a.type === "expense").id;
  await api("POST", "/api/entries", { kind: "expense", date: "2030-10-05", amount: 30000, from_account_id: card, category_id: other });
});

const short = async (today: string) => (await balances(db, today)).shortfalls.filter((x: any) => x.account_id === bank);

describe("引き落としの残高不足", () => {
  it("引き落とし日まで日があるうちは出さない", async () => {
    expect(SHORTFALL_DAYS).toBe(7);
    expect(await short("2030-11-18")).toEqual([]);
  });

  it(`引き落とし日の${SHORTFALL_DAYS}日前から当日まで出す`, async () => {
    for (const today of ["2030-11-19", "2030-11-26"]) {
      expect(await short(today)).toEqual([{ account_id: bank, name: "不足銀行", balance: 10000, due: 30000, date: "2030-11-26" }]);
    }
  });

  it("来月以降に落ちる分は数えない", async () => {
    await api("POST", "/api/entries", {
      kind: "expense", date: "2030-11-20", amount: 50000, from_account_id: card,
      category_id: (await api<any[]>("GET", "/api/accounts")).find((a) => a.name === "その他" && a.type === "expense").id,
    });
    expect((await short("2030-11-20"))[0].due).toBe(30000);
  });

  it("引き落としを記録したあとは出さない", async () => {
    await recordDuePayments(db, "2030-11-26");
    expect(await short("2030-11-26")).toEqual([]);
  });
});
