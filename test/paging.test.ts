// 一覧のページング。cursor で続きを読み、重複や取りこぼしがないことを確かめる。

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
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

let bank: number, other: number;

beforeAll(async () => {
  bank = (await api("POST", "/api/accounts", { name: "ページ銀行", type: "asset", kind: "bank" })).id;
  other = (await api<any[]>("GET", "/api/accounts")).find((a) => a.name === "その他").id;
  for (let i = 0; i < 25; i++) {
    await api("POST", "/api/entries", {
      kind: "expense", date: `2026-10-${String(i + 1).padStart(2, "0")}`, amount: 100 + i,
      from_account_id: bank, category_id: other, payee: `ページ店${i}`,
    });
  }
});

describe("一覧のページング", () => {
  it("cursor で10件ずつ読み、最後まで重複なく取れる", async () => {
    const first = await api<any>("GET", "/api/entries?month=2026-10&paged=1&limit=10");
    expect(first.entries).toHaveLength(10);
    expect(first.next_cursor).toBeTruthy();

    const second = await api<any>("GET", `/api/entries?month=2026-10&paged=1&limit=10&cursor=${encodeURIComponent(first.next_cursor)}`);
    expect(second.entries).toHaveLength(10);
    expect(second.next_cursor).toBeTruthy();

    const third = await api<any>("GET", `/api/entries?month=2026-10&paged=1&limit=10&cursor=${encodeURIComponent(second.next_cursor)}`);
    expect(third.entries).toHaveLength(5);
    expect(third.next_cursor).toBeNull();

    const ids = [...first.entries, ...second.entries, ...third.entries].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(25);
  });

  it("paged を付けない今までの呼び方は、配列のまま返る", async () => {
    const entries = await api<any[]>("GET", "/api/entries?month=2026-10&limit=3");
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(3);
  });

  it("壊れた cursor は 400 になる", async () => {
    await expect(api("GET", "/api/entries?paged=1&cursor=broken")).rejects.toThrow("400");
  });
});
