// ホームの件数 API と、保存前にAIの判断を確かめるための分類 API。

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { todayJST } from "../src/lib/dates";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;

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

let bank: number, card: number, other: number;

beforeAll(async () => {
  bank = (await api("POST", "/api/accounts", { name: "件数銀行", type: "asset", kind: "bank" })).id;
  card = (await api("POST", "/api/accounts", {
    name: "件数カード", type: "liability", kind: "card", closing_day: 15, payment_day: 10, payment_account_id: bank,
  })).id;
  other = await category("その他");
});

describe("ホームの件数", () => {
  it("明細を取らずに、未照合・立て替え・AIの未確認の件数だけを返す", async () => {
    // カードの手入力は、明細と照合するまで仮の取引になる
    await api("POST", "/api/entries", {
      kind: "expense", date: todayJST(), amount: 1200, from_account_id: card, category_id: other, payee: "店",
    });
    // 回収待ちの立て替え
    await api("POST", "/api/entries", {
      kind: "expense", date: todayJST(), amount: 2000, from_account_id: bank, category_id: other, payee: "立替", advance: true,
    });
    // 精算済みの立て替えは数えない
    const settled = await api("POST", "/api/entries", {
      kind: "expense", date: todayJST(), amount: 3000, from_account_id: bank, category_id: other, payee: "精算済み", advance: true,
    });
    await api("POST", `/api/entries/${settled.id}/settle`, {});
    // カテゴリを決めずに保存した支出は、あとで確かめる対象になる
    await api("POST", "/api/entries", {
      kind: "expense", date: todayJST(), amount: 400, from_account_id: bank, payee: "なにかの店",
    });

    const counts = await api<{ provisional: number; advances: number; unsure: number }>("GET", "/api/counts");
    expect(counts.provisional).toBe(1);
    expect(counts.advances).toBe(1);
    expect(counts.unsure).toBe(1);
  });
});

describe("保存前の分類", () => {
  it("キーワードで決まる店は、カテゴリ名つきで返す", async () => {
    const r = await api<{ category_id: number; category_name: string; category_source: string }>(
      "POST", "/api/classify/one", { payee: "ミニストップ 仙台薬師堂駅前店" },
    );
    expect(r.category_name).toBe("コンビニ");
    expect(r.category_source).toBe("keyword");
  });

  it("決められない店は、その他を返す", async () => {
    const r = await api<{ category_id: number; category_name: string; category_source: string }>(
      "POST", "/api/classify/one", { payee: "なにかの店" },
    );
    expect(r.category_name).toBe("その他");
    expect(r.category_source).toBe("none");
  });
});
