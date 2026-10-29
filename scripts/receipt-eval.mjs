#!/usr/bin/env node
// レシート読み取りの比較検証を、手元のレシート画像でまとめて行う。
//
// 使い方:
//   node scripts/receipt-eval.mjs --url https://kakeibo.example.workers.dev --dir ./receipts
//
// --dir には画像と expected.csv を置く。expected.csv は「file,date,total」の3列で、正しい日付と合計を書く。
//   file,date,total
//   001.jpg,2026-10-20,1280
// Cloudflare Access の service token を使う場合は CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET を環境変数に入れる。
// Worker 側では ENABLE_RECEIPT_EVAL を "1" にしておく。
// 結果は --dir の eval-results.json に保存し、モデルごとの一致率と平均の時間、トークン数を表に出す。

import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

// 2026-10-29 に料金ページで確かめた値。Neurons/100万トークン
const PRICES = {
  "@cf/meta/llama-4-scout-17b-16e-instruct": [24545, 77273],
  "@cf/mistralai/mistral-small-3.1-24b-instruct": [31876, 50488],
  "@cf/meta/llama-3.2-11b-vision-instruct": [4410, 61493],
  "@cf/moondream/moondream3.1-9B-A2B": [27273, 90909],
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const url = arg("url");
const dir = arg("dir");
const models = arg("models", "");
if (!url || !dir) {
  console.error("--url と --dir を指定してください");
  process.exit(1);
}

const expected = (await readFile(join(dir, "expected.csv"), "utf8"))
  .split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
    const [file, date, total] = l.split(",").map((s) => s.trim());
    return { file, date, total: Number(total) };
  });

const headers = {};
if (process.env.CF_ACCESS_CLIENT_ID) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET ?? "";
}

const mimeOf = (f) => ({ ".png": "image/png", ".webp": "image/webp" })[extname(f).toLowerCase()] ?? "image/jpeg";
const all = [];
for (const exp of expected) {
  const bytes = await readFile(join(dir, exp.file));
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mimeOf(exp.file) }), basename(exp.file));
  if (models) form.append("models", models);
  const res = await fetch(new URL("/api/dev/receipt-eval", url), { method: "POST", body: form, headers });
  if (!res.ok) {
    console.error(exp.file, res.status, await res.text());
    continue;
  }
  const { results } = await res.json();
  for (const r of results) {
    const p = r.parsed ?? {};
    all.push({
      file: exp.file,
      model: r.model,
      ok: r.ok,
      ms: r.ms,
      usage: r.usage,
      total_ok: Number(p.total) === exp.total,
      date_ok: p.date === exp.date,
      items_sum_ok: Array.isArray(p.items) && p.items.reduce((s, i) => s + (Number(i.amount) || 0), 0) === exp.total,
      parsed: p,
      error: r.error,
    });
  }
  process.stdout.write(".");
}
process.stdout.write("\n");
await writeFile(join(dir, "eval-results.json"), JSON.stringify(all, null, 2));

const byModel = Map.groupBy(all, (r) => r.model);
const rows = [];
for (const [model, rs] of byModel) {
  const n = rs.length;
  const avg = (f) => rs.reduce((s, r) => s + f(r), 0) / n;
  const inTok = avg((r) => r.usage?.prompt_tokens ?? 0);
  const outTok = avg((r) => r.usage?.completion_tokens ?? 0);
  const [pi, po] = PRICES[model] ?? [0, 0];
  rows.push({
    model,
    件数: n,
    失敗: rs.filter((r) => !r.ok).length,
    合計一致: `${Math.round((rs.filter((r) => r.total_ok).length / n) * 100)}%`,
    日付一致: `${Math.round((rs.filter((r) => r.date_ok).length / n) * 100)}%`,
    品目の和が合計と一致: `${Math.round((rs.filter((r) => r.items_sum_ok).length / n) * 100)}%`,
    平均ms: Math.round(avg((r) => r.ms)),
    平均入力トークン: Math.round(inTok),
    平均出力トークン: Math.round(outTok),
    "1枚のNeurons(推定)": Math.round((inTok * pi + outTok * po) / 1e6),
  });
}
console.table(rows);
