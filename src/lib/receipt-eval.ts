// レシート読み取りの比較検証。同じ画像を候補の視覚モデルに通し、読み取り結果、かかった時間、トークン数を返す。
// 本番の読み取り機能を作る前に、どのモデルで日本語のレシートを読めるかを確かめるためのもの。

import type { Env } from "../types";
import { LedgerError } from "./ledger";

export const RECEIPT_MODELS = [
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/moondream/moondream3.1-9B-A2B",
];

export const RECEIPT_PROMPT = [
  "これは日本のレシートの写真です。書かれている内容を読み取り、次の形のJSONだけを返してください。",
  '{"store":"店名","date":"YYYY-MM-DD","items":[{"name":"品名","amount":印字されている金額の整数,"quantity":数量}],',
  '"tax_mode":"外税なら outside、内税なら inside","tax":消費税の額の整数,"total":支払った合計の整数,',
  '"payment":"現金やカードなど支払方法","card_last4":"カードの下4桁があれば"}',
  "store には、ロゴの英字ではなく、レシートに日本語で印字された店名を入れてください。会社名と店舗名があれば店舗名にします。日本語の表記がないときだけ英字にします。",
  "items には買った商品と、値引きや割引の行だけを入れてください。値引きは金額をマイナスにします。",
  "小計、外税品計、内税対象、消費税、合計、総合計、お預り、お釣り、クレジット、ポイントの行は items に入れないでください。",
  "金額は印字のまま写し、自分で税を足したり引いたりしないでください。読めない項目は null にしてください。",
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

export async function runModel(env: Env, model: string, image: Uint8Array, mime: string): Promise<{ text: string; usage: unknown }> {
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

export const DEFAULT_RECEIPT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export interface Receipt {
  store: string | null;
  date: string | null;
  total: number | null;
  items: { name: string; amount: number; quantity: number | null }[];
}

const toInt = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[,円¥\s]/g, "")) : Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : Math.round(n);
};

/** 本番のレシート読み取り。モデルは RECEIPT_MODEL で替えられる */
export async function readReceipt(env: Env, image: Uint8Array, mime: string): Promise<Receipt> {
  if (!env.AI) throw new LedgerError("AIが使えないため、レシートを読めません", 503);
  const { text } = await runModel(env, env.RECEIPT_MODEL || DEFAULT_RECEIPT_MODEL, image, mime);
  const p = extractJSON(text) as Record<string, unknown> | null;
  if (!p) throw new LedgerError("レシートを読み取れませんでした。明るい場所で、レシート全体が入るように撮ってください");
  const date = typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : null;
  const items = Array.isArray(p.items) ? p.items.map((i: Record<string, unknown>) => ({
    name: String(i?.name ?? "").trim(),
    amount: toInt(i?.amount) ?? NaN,
    quantity: toInt(i?.quantity),
  })) : [];
  return normalizeReceipt({ store: typeof p.store === "string" ? p.store : null, date, total: toInt(p.total), items }, toInt(p.tax));
}

// 品目に紛れ込みやすい、合計や税、支払いの行
const NOT_ITEM = /(小計|合計|品計|外税|内税|消費税|税率|対象|お預|預り|釣|クレジット|現金|電子マネー|ポイント|支払)/;

/**
 * 読み取った品目を、合計と合う税込の金額にそろえる。
 * 合計や税の行を除き、ほかの品目を打ち消すだけのマイナスの行も除く。
 * 外税で品目の合計が足りないときは、消費税を品目の金額に比べて割り振る。
 */
export function normalizeReceipt(r: Receipt, tax: number | null): Receipt {
  let items = r.items.filter((i) => i.name && Number.isInteger(i.amount) && i.amount !== 0 && !NOT_ITEM.test(i.name));
  const positive = items.filter((i) => i.amount > 0).reduce((s, i) => s + i.amount, 0);
  items = items.filter((i) => !(i.amount < 0 && -i.amount >= positive));
  const total = r.total ?? items.reduce((s, i) => s + i.amount, 0);
  const sum = items.reduce((s, i) => s + i.amount, 0);
  const gap = total - sum;
  // 外税の消費税や端数の切り捨てと見てよい差だけを割り振る。大きくずれるときは画面で直してもらう
  const looksLikeTax = gap > 0 && sum > 0 && (gap === tax || gap <= Math.ceil(sum * 0.1) + items.length);
  if (looksLikeTax) {
    const base = items.map((i) => Math.max(i.amount, 0));
    const baseSum = base.reduce((s, v) => s + v, 0);
    const shares = base.map((v) => Math.floor((gap * v) / baseSum));
    let left = gap - shares.reduce((s, v) => s + v, 0);
    // 余りは端数の大きい品目から1円ずつ足す
    const order = base.map((v, i) => [((gap * v) / baseSum) % 1, i] as const).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) { if (left-- <= 0) break; shares[i]++; }
    items = items.map((it, i) => ({ ...it, amount: it.amount + shares[i] }));
  }
  return { ...r, total, items };
}
