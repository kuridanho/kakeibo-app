// 本番の D1(kakeibo)を読み取りだけで書き出し、プレビュー用の D1(kakeibo-preview)を作り直す。
// 本番には書き込まない。書き込む先はプレビュー用の D1 だけで、名前を固定している。
// 使い方: node scripts/preview-copy-db.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = "kakeibo";
const TARGET = "kakeibo-preview";
const dir = mkdtempSync(join(tmpdir(), "kakeibo-preview-"));
const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

wrangler(["d1", "export", SOURCE, "--remote", "--output", join(dir, "dump.sql")]);
const dump = readFileSync(join(dir, "dump.sql"), "utf8");

// 書き出しは表ごとに CREATE と INSERT が並び、外部キーの親より子が先に来ることがある。
// D1 はファイルを分けて流すので、外部キーの検査を後回しにしても区切りをまたぐと失敗する。
// 表をすべて作ってから、親の表から順に行を入れ、索引を最後に作る
const statements = dump.split(/;\n/).map((s) => s.trim()).filter(Boolean);
const tables = statements.filter((s) => /^CREATE TABLE/i.test(s));
const tableName = (s) => s.match(/^(?:CREATE TABLE(?: IF NOT EXISTS)?|INSERT INTO)\s+"?([\w]+)"?/i)?.[1];
const order = [];
const pending = [...tables];
while (pending.length) {
  const ready = pending.filter((t) => [...t.matchAll(/REFERENCES\s+"?(\w+)"?/gi)]
    .every(([, parent]) => parent === tableName(t) || order.includes(parent) || !tables.some((o) => tableName(o) === parent)));
  const batch = ready.length ? ready : pending;
  for (const t of batch) order.push(tableName(t));
  for (const t of batch) pending.splice(pending.indexOf(t), 1);
}
const inserts = statements.filter((s) => /^INSERT/i.test(s));
inserts.sort((a, b) => {
  const rank = (s) => (tableName(s) === "sqlite_sequence" ? order.length : order.indexOf(tableName(s)));
  return rank(a) - rank(b);
});
const sequence = statements.filter((s) => /^DELETE FROM sqlite_sequence/i.test(s));
const indexes = statements.filter((s) => /^CREATE (UNIQUE )?INDEX/i.test(s));

const current = JSON.parse(wrangler(["d1", "execute", TARGET, "--remote", "--json", "--command",
  "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"]));
// 参照されている表を先に消すと外部キーの検査で巻き戻るので、参照する側から消す
let left = current[0]?.results ?? [];
const drops = [];
while (left.length) {
  const next = left.filter((t) => !left.some((o) => o !== t && new RegExp(`REFERENCES\\s+"?${t.name}"?\\b`, "i").test(o.sql)));
  const batch = next.length ? next : left;
  for (const t of batch) drops.push(`DROP TABLE IF EXISTS "${t.name}"`);
  left = left.filter((t) => !batch.includes(t));
}

const run = (name, list) => {
  if (!list.length) return;
  writeFileSync(join(dir, name), ["PRAGMA defer_foreign_keys = true", ...list].join(";\n") + ";\n");
  wrangler(["d1", "execute", TARGET, "--remote", "--file", join(dir, name), "-y"]);
};
run("drop.sql", drops);
run("load.sql", [...tables, ...sequence, ...inserts, ...indexes]);
console.log(`${TARGET} に ${SOURCE} の ${inserts.length} 行を写した`);
