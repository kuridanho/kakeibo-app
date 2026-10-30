// AIやキーワード表が決めたカテゴリを、まとめて確かめる。

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

async function category(name: string): Promise<number> {
  const all = await api<any[]>("GET", "/api/accounts");
  return all.find((a) => a.name === name && a.type === "expense").id;
}

const spend = (payee: string, date: string, amount: number) =>
  api("POST", "/api/entries", { kind: "expense", date, amount, from_account_id: wallet, payee });

let wallet: number;

beforeAll(async () => {
  wallet = (await api("POST", "/api/accounts", { name: "財布", type: "asset", kind: "cash" })).id;
});

describe("カテゴリをまとめて確かめる", () => {
  it("そのままのものは確定し、変えたものは付け替え、次から同じ店は確かめる一覧に出ない", async () => {
    const a = await spend("ミニストップ 仙台駅前店", "2026-10-21", 645);
    const b = await spend("ミニストップ 仙台駅前店", "2026-10-22", 1122);
    const c = await spend("ローソン 長町店", "2026-10-23", 300);
    // テストではAIを使わないので、キーワード表で決まる
    expect([a, b, c].map((r) => r.category_source)).toEqual(["keyword", "keyword", "keyword"]);
    const dining = await category("外食");

    const r = await api("POST", "/api/entries/confirm-categories", {
      items: [
        { id: a.id, category_id: a.category_id },
        { id: b.id, category_id: b.category_id },
        { id: c.id, category_id: dining },
      ],
    });
    expect(r).toEqual({ confirmed: 3, changed: 1 });

    const ea = await api("GET", `/api/entries/${a.id}`);
    expect(ea.category_source).toBe("user");
    expect(ea.lines.find((l: any) => l.type === "expense").account_id).toBe(a.category_id);
    const ec = await api("GET", `/api/entries/${c.id}`);
    expect(ec.category_source).toBe("user");
    expect(ec.lines.find((l: any) => l.type === "expense").account_id).toBe(dining);

    // 覚えた対応で決まるので、AIが決めたものとして扱わない
    const again = await spend("ミニストップ 仙台駅前店", "2026-10-25", 637);
    expect(again.category_source).toBe("rule");
    expect(again.category_id).toBe(a.category_id);
    const lawson = await spend("ローソン 長町店", "2026-10-26", 200);
    expect(lawson.category_id).toBe(dining);
  });

  it("確定済みの取引は飛ばし、収入のカテゴリは選べない", async () => {
    const d = await spend("ファミリーマート 北四番丁店", "2026-10-24", 400);
    await api("POST", "/api/entries/confirm-categories", { items: [{ id: d.id, category_id: d.category_id }] });
    const twice = await api("POST", "/api/entries/confirm-categories", { items: [{ id: d.id, category_id: d.category_id }] });
    expect(twice).toEqual({ confirmed: 0, changed: 0 });

    const e = await spend("セブンイレブン 一番町店", "2026-10-24", 500);
    const all = await api<any[]>("GET", "/api/accounts");
    const income = all.find((x) => x.type === "income").id;
    await expect(api("POST", "/api/entries/confirm-categories", { items: [{ id: e.id, category_id: income }] }))
      .rejects.toThrow("400");
  });
});
