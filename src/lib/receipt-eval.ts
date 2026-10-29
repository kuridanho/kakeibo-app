// レシート読み取りの比較検証。同じ画像を候補の視覚モデルに通し、読み取り結果、かかった時間、トークン数を返す。
// 本番の読み取り機能を作る前に、どのモデルで日本語のレシートを読めるかを確かめるためのもの。

import type { Env } from "../types";

export const RECEIPT_MODELS = [
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/moondream/moondream3.1-9B-A2B",
];

export const RECEIPT_PROMPT = [
  "これは日本のレシートの写真です。書かれている内容を読み取り、次の形のJSONだけを返してください。",
  '{"store":"店名","date":"YYYY-MM-DD","items":[{"name":"品名","amount":税込の金額の整数,"quantity":数量}],',
  '"total":合計の整数,"payment":"現金やカードなど支払方法","card_last4":"カードの下4桁があれば"}',
  "読めない項目は null にしてください。値引きは金額をマイナスにして品目に入れてください。",
].join("\n");

export interface ModelResult {
  model: string;
  ok: boolean;
  ms: number;
  usage: unknown;
  parsed: unknown;
  raw: string;
  error?: string;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function extractJSON(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function runModel(env: Env, model: string, image: Uint8Array, mime: string): Promise<{ text: string; usage: unknown }> {
  const ai = env.AI!;
  let input: Record<string, unknown>;
  if (model.includes("llama-3.2-11b-vision")) {
    input = { messages: [{ role: "user", content: RECEIPT_PROMPT }], image: [...image], max_tokens: 1024, temperature: 0 };
  } else {
    input = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: RECEIPT_PROMPT },
          { type: "image_url", image_url: { url: `data:${mime};base64,${toBase64(image)}` } },
        ],
      }],
      max_tokens: 1024,
      temperature: 0,
    };
  }
  let out: { response?: unknown; usage?: unknown; description?: string };
  try {
    out = (await ai.run(model as keyof AiModels, input as never)) as typeof out;
  } catch (e) {
    // llama-3.2-11b-vision は、最初に一度ライセンスへの同意を送る必要がある
    if (String(e).toLowerCase().includes("agree")) {
      await ai.run(model as keyof AiModels, { prompt: "agree" } as never);
      out = (await ai.run(model as keyof AiModels, input as never)) as typeof out;
    } else {
      throw e;
    }
  }
  const resp = out?.response ?? out?.description ?? out;
  return { text: typeof resp === "string" ? resp : JSON.stringify(resp), usage: out?.usage ?? null };
}

export async function evaluateReceipt(env: Env, image: Uint8Array, mime: string, models: string[]): Promise<{ results: ModelResult[] }> {
  if (!env.AI) return { results: [] };
  const list = models.length > 0 ? models : RECEIPT_MODELS;
  const results: ModelResult[] = [];
  for (const model of list) {
    const started = Date.now();
    try {
      const { text, usage } = await runModel(env, model, image, mime);
      results.push({ model, ok: true, ms: Date.now() - started, usage, parsed: extractJSON(text), raw: text });
    } catch (e) {
      results.push({ model, ok: false, ms: Date.now() - started, usage: null, parsed: null, raw: "", error: String(e) });
    }
  }
  return { results };
}
