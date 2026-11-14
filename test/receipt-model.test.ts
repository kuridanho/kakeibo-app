import { afterEach, describe, expect, it, vi } from "vitest";
import { readReceipt } from "../src/lib/receipt-eval";
import type { Env } from "../src/types";

const json = { store: "店", date: "2026-11-14", total: 300, tax: null, items: [{ name: "パン", amount: 300, quantity: 1 }], lines: [] };
const img = new Uint8Array([1, 2, 3]);

function envWith(extra: Partial<Env> = {}) {
  const run = vi.fn(async (_model: string, _input: unknown) => ({ response: JSON.stringify({ ...json, store: "Scout" }) }));
  return { env: { AI: { run }, ...extra } as unknown as Env, run };
}

afterEach(() => vi.unstubAllGlobals());

describe("レシート読み取りのモデル", () => {
  it("キーがなければ Scout で読む", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { env, run } = envWith();
    const r = await readReceipt(env, img, "image/jpeg");
    expect(r.store).toBe("Scout");
    expect(fetch).not.toHaveBeenCalled();
    expect(run.mock.calls[0][0]).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
  });

  it("キーがあれば Gemini で読む", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ ...json, store: "Gemini" }) }] }, finishReason: "STOP" }],
    }));
    vi.stubGlobal("fetch", fetch);
    const { env, run } = envWith({ GEMINI_API_KEY: "k" });
    const r = await readReceipt(env, img, "image/jpeg");
    expect(r.store).toBe("Gemini");
    expect(String(fetch.mock.calls[0][0])).toContain("models/gemini-3.5-flash-lite:generateContent");
    expect(run).not.toHaveBeenCalled();
  });

  it("上限を超えたら Scout で読み直す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
    const { env } = envWith({ GEMINI_API_KEY: "k" });
    expect((await readReceipt(env, img, "image/jpeg")).store).toBe("Scout");
  });

  it("途中で打ち切られたら Scout で読み直す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      candidates: [{ content: { parts: [{ text: '{"store":"G' }] }, finishReason: "MAX_TOKENS" }],
    })));
    const { env } = envWith({ GEMINI_API_KEY: "k" });
    expect((await readReceipt(env, img, "image/jpeg")).store).toBe("Scout");
  });

  it("RECEIPT_MODEL で Workers AI のモデルに戻せる", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { env, run } = envWith({ GEMINI_API_KEY: "k", RECEIPT_MODEL: "@cf/mistralai/mistral-small-3.1-24b-instruct" });
    await readReceipt(env, img, "image/jpeg");
    expect(fetch).not.toHaveBeenCalled();
    expect(run.mock.calls[0][0]).toBe("@cf/mistralai/mistral-small-3.1-24b-instruct");
  });
});
