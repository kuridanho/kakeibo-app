// public/ の画面を Worker に埋め込んでデプロイする。
// 静的アセットのアップロードは専用の一時トークンを Authorization ヘッダーで送るため、
// API トークンを通信に差し込む作業環境(Claude のクラウド環境など)では 401 になる。
// その環境では、画面のファイルを Worker のコードに入れて、スクリプトのアップロードだけで済ませる。
// 手元の Mac などからは、ふだんどおり npm run deploy を使う。
//
// 使い方: node scripts/deploy-embedded.mjs [--without-r2] [wrangler deploy に渡す引数...]
// --without-r2 は R2 をまだ有効にしていないとき用。明細CSVの保存と毎日の控えが止まる

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const outDir = join(root, ".wrangler", "embedded");
mkdirSync(outDir, { recursive: true });

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const files = {};
for (const name of readdirSync(join(root, "public"))) {
  const type = types[extname(name)];
  if (!type) continue;
  files[`/${name}`] = { type, body: readFileSync(join(root, "public", name)).toString("base64") };
}

writeFileSync(join(outDir, "entry.ts"), `// scripts/deploy-embedded.mjs が作るファイル。編集しない
import worker from "../../src/index";
import type { Env } from "../../src/types";

const files: Record<string, { type: string; body: string }> = ${JSON.stringify(files)};
const decoded = new Map<string, Uint8Array>();

function serve(path: string): Response {
  // 画面はハッシュで切り替えるので、知らないパスには index.html を返す
  const key = files[path] ? path : "/index.html";
  const file = files[key];
  let body = decoded.get(key);
  if (!body) {
    body = Uint8Array.from(atob(file.body), (c) => c.charCodeAt(0));
    decoded.set(key, body);
  }
  const cache = key === "/index.html" || key === "/sw.js" ? "no-cache" : "public, max-age=300";
  return new Response(body, { headers: { "content-type": file.type, "cache-control": cache } });
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return worker.fetch(request, env, ctx);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
    return serve(url.pathname);
  },
  scheduled: worker.scheduled,
} satisfies ExportedHandler<Env>;
`);

// wrangler.jsonc からアセットの設定を外し、入口を埋め込み版に替えた設定を作る
const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/,(\s*[}\]])/g, "$1"));
delete config.assets;
delete config.$schema;
config.main = "entry.ts";
for (const db of config.d1_databases ?? []) db.migrations_dir = join(root, db.migrations_dir ?? "migrations");
const args = process.argv.slice(2);
if (args.includes("--without-r2")) delete config.r2_buckets;
const configPath = join(outDir, "wrangler.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));

execFileSync("npx", ["wrangler", "deploy", "-c", configPath, ...args.filter((a) => a !== "--without-r2")], { stdio: "inherit", cwd: root });
