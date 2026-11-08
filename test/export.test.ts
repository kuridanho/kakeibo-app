import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";

const token = "t".repeat(40);
const testEnv = { ...(env as unknown as Env), EXPORT_TOKEN: token };
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, testEnv);

describe("エクスポート", () => {
  it("Bearer のトークンで全部の表と計算結果を返す", async () => {
    await app.request("/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-authenticated-user-email": "me@example.com" },
      body: JSON.stringify({ name: "財布", type: "asset", kind: "cash" }),
    }, testEnv);
    const res = await get("/api/export", { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(Object.keys(body.tables)).toContain("entries");
    expect(body.tables.accounts.some((a: any) => a.name === "財布")).toBe(true);
    expect(body.computed.balances).toBeTruthy();
  });

  it("表を絞れる", async () => {
    const res = await get("/api/export?tables=accounts&computed=0", { authorization: `Bearer ${token}` });
    const body = await res.json<any>();
    expect(Object.keys(body.tables)).toEqual(["accounts"]);
    expect(body.computed).toBeUndefined();
    expect((await get("/api/export?tables=nope", { authorization: `Bearer ${token}` })).status).toBe(400);
  });

  it("トークンが違えば通さず、トークンで他のAPIは開かない", async () => {
    expect((await get("/api/export", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await get("/api/export")).status).toBe(401);
    expect((await get("/api/accounts", { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("EXPORT_TOKEN が無ければトークンでは通さない", async () => {
    const res = await app.request("/api/export", { headers: { authorization: "Bearer " } }, env as unknown as Env);
    expect(res.status).toBe(401);
  });
});
