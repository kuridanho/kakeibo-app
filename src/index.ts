import { Hono } from "hono";
import type { Account, Entry, Env } from "./types";
import { classifyMerchants, classifyOne, learnRule, merchantKey } from "./lib/classify";
import { addMonths, monthOf, todayJST } from "./lib/dates";
import {
  balanceOf, buildSimple, createEntry, deleteEntry, getAccount, getEntry, LedgerError, logChange,
  resolveAccount, type SimpleInput, updateEntry,
} from "./lib/ledger";
import { balances, closeMonth, daily, monthSummary, yearSummary } from "./lib/reports";
import { evaluateReceipt } from "./lib/receipt-eval";
import { StatementParseError } from "./lib/smbc";
import { commitStatement, previewStatement } from "./lib/statement";

type App = { Bindings: Env; Variables: { user: string | null } };

const app = new Hono<App>();

app.use("/api/*", async (c, next) => {
  // Cloudflare Access を通ったリクエストには利用者のメールアドレスが付く
  c.set("user", c.req.header("cf-access-authenticated-user-email") ?? null);
  await next();
});

app.onError((err, c) => {
  if (err instanceof LedgerError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof StatementParseError) return c.json({ error: err.message }, 400);
  if (err instanceof SyntaxError) return c.json({ error: "JSONを読み取れません" }, 400);
  console.error(err);
  return c.json({ error: "サーバーでエラーが起きました" }, 500);
});

const int = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new LedgerError(`${what}は整数で入れてください`);
  return n;
};

// ---- 口座と費目 ----

const ACCOUNT_KINDS: Record<string, string[]> = {
  asset: ["cash", "bank", "emoney", "savings", "investment", "receivable"],
  liability: ["card", "loan"],
  income: ["category"],
  expense: ["category"],
};
async function checkPaymentAccount(db: D1Database, id: unknown) {
  if (id === undefined || id === null) return;
  const a = await getAccount(db, int(id, "引き落とし口座"));
  if (a.type !== "asset") throw new LedgerError("引き落とし口座には銀行口座などの資産を選んでください");
}

const EDITABLE = ["name", "liquid", "closing_day", "payment_day", "payment_account_id", "payment_amount",
  "check_interval_days", "statement_card_name", "statement_import", "sort_order", "archived"] as const;

app.get("/api/accounts", async (c) => {
  const { results } = await c.env.DB
    .prepare("SELECT * FROM accounts ORDER BY CASE type WHEN 'asset' THEN 0 WHEN 'liability' THEN 1 WHEN 'expense' THEN 2 WHEN 'income' THEN 3 ELSE 4 END, sort_order, id")
    .all<Account>();
  return c.json(results);
});

app.post("/api/accounts", async (c) => {
  const body = await c.req.json<Partial<Account>>();
  const type = body.type ?? "asset";
  const kind = type === "income" || type === "expense" ? "category" : body.kind ?? "";
  if (!ACCOUNT_KINDS[type]?.includes(kind)) throw new LedgerError("口座の種類が正しくありません");
  if (!body.name?.trim()) throw new LedgerError("名前を入れてください");
  await checkPaymentAccount(c.env.DB, body.payment_account_id);
  // 財布、普通預金、電子マネーは手元の現金に数える。定期預金や投資は別枠
  const liquid = body.liquid ?? (["cash", "bank", "emoney"].includes(kind) ? 1 : 0);
  const row = await c.env.DB
    .prepare(`INSERT INTO accounts (name, type, kind, liquid, closing_day, payment_day, payment_account_id, payment_amount,
        check_interval_days, statement_card_name, statement_import, sort_order, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM accounts WHERE type = ?)), ?)
      RETURNING *`)
    .bind(body.name.trim(), type, kind, liquid, body.closing_day ?? null, body.payment_day ?? null,
      body.payment_account_id ?? null, body.payment_amount ?? null, body.check_interval_days ?? null,
      body.statement_card_name ?? null, body.statement_import ?? 1, body.sort_order ?? null, type, c.get("user"))
    .first<Account>();
  return c.json(row, 201);
});

app.patch("/api/accounts/:id", async (c) => {
  const id = int(c.req.param("id"), "id");
  await getAccount(c.env.DB, id);
  const body = await c.req.json<Record<string, unknown>>();
  const cols = EDITABLE.filter((k) => k in body);
  if (cols.length === 0) throw new LedgerError("変更する項目がありません");
  if ("payment_account_id" in body) await checkPaymentAccount(c.env.DB, body.payment_account_id);
  const row = await c.env.DB
    .prepare(`UPDATE accounts SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ? RETURNING *`)
    .bind(...cols.map((k) => body[k] ?? null), id)
    .first<Account>();
  return c.json(row);
});

/** 費目の統合。過去の取引と学んだ対応を統合先に移し、統合元は隠す */
app.post("/api/categories/:id/merge", async (c) => {
  const db = c.env.DB;
  const from = await getAccount(db, int(c.req.param("id"), "id"));
  const { into } = await c.req.json<{ into: number }>();
  const to = await resolveAccount(db, int(into, "統合先"));
  if (from.id === to.id) throw new LedgerError("同じ費目には統合できません");
  if (from.type !== to.type || (from.type !== "expense" && from.type !== "income")) {
    throw new LedgerError("同じ種類の費目どうしだけ統合できます");
  }
  if (from.origin === "system") throw new LedgerError("この費目は統合できません");
  const { results } = await db
    .prepare(`SELECT substr(e.report_date, 1, 7) AS month, SUM(l.amount) AS amount FROM lines l
      JOIN entries e ON e.id = l.entry_id WHERE l.account_id = ? GROUP BY month`)
    .bind(from.id)
    .all<{ month: string; amount: number }>();
  const sign = from.type === "income" ? -1 : 1;
  const delta: Record<string, Record<string, number>> = {};
  for (const r of results) delta[r.month] = { [from.id]: -sign * r.amount, [to.id]: sign * r.amount };
  await db.batch([
    db.prepare("UPDATE lines SET account_id = ? WHERE account_id = ?").bind(to.id, from.id),
    db.prepare("UPDATE category_rules SET account_id = ? WHERE account_id = ?").bind(to.id, from.id),
    db.prepare("UPDATE accounts SET merged_into_id = ? WHERE merged_into_id = ?").bind(to.id, from.id),
    db.prepare("UPDATE accounts SET archived = 1, merged_into_id = ? WHERE id = ?").bind(to.id, from.id),
  ]);
  // 予算の表ができたら、ここで予算も統合先に移す
  await logChange(db, "merge_category", delta, `費目の統合 ${from.name} を ${to.name} へ`);
  return c.json({ merged: from.id, into: to.id, moved_months: results.length });
});

app.get("/api/rules", async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT r.*, a.name AS account_name FROM category_rules r JOIN accounts a ON a.id = r.account_id
      ORDER BY r.origin DESC, r.pattern`)
    .all();
  return c.json(results);
});

app.post("/api/rules", async (c) => {
  const { pattern, match, account_id } = await c.req.json<{ pattern: string; match?: string; account_id: number }>();
  const key = merchantKey(pattern ?? "");
  if (!key) throw new LedgerError("利用先の文字を入れてください");
  await resolveAccount(c.env.DB, int(account_id, "費目"));
  await c.env.DB
    .prepare(`INSERT INTO category_rules (pattern, match, account_id, origin, user_id) VALUES (?, ?, ?, 'user', ?)
      ON CONFLICT (pattern, match) DO UPDATE SET account_id = excluded.account_id, origin = 'user'`)
    .bind(key, match === "contains" ? "contains" : "exact", account_id, c.get("user"))
    .run();
  return c.json({ ok: true }, 201);
});

app.delete("/api/rules/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM category_rules WHERE id = ?").bind(int(c.req.param("id"), "id")).run();
  return c.json({ ok: true });
});

app.post("/api/classify", async (c) => {
  const { merchants } = await c.req.json<{ merchants: string[] }>();
  const map = await classifyMerchants(c.env, (merchants ?? []).slice(0, 200));
  return c.json(Object.fromEntries(map));
});

// ---- 開始残高 ----

/**
 * 使い始めに、分かっている口座の残高だけを入れる。口座ごとに1件の開始残高の仕訳にし、入れ直すと置き換える。
 * カードの未払いと借入は、借りている額を正の数で入れる。
 */
app.post("/api/opening", async (c) => {
  const db = c.env.DB;
  const { date, balances: list } = await c.req.json<{ date?: string; balances: { account_id: number; amount: number }[] }>();
  const day = date ?? todayJST();
  const equity = await db.prepare("SELECT * FROM accounts WHERE kind = 'opening'").first<Account>();
  const ids: number[] = [];
  for (const b of list ?? []) {
    const a = await getAccount(db, int(b.account_id, "口座"));
    const amount = int(b.amount, "残高");
    if (a.type !== "asset" && a.type !== "liability") throw new LedgerError(`${a.name} は残高を持つ口座ではありません`);
    const signed = a.type === "asset" ? amount : -amount;
    const autoKey = `opening:${a.id}`;
    const existing = await db.prepare("SELECT id FROM entries WHERE auto_key = ?").bind(autoKey).first<{ id: number }>();
    const lines = [{ account_id: a.id, amount: signed }, { account_id: equity!.id, amount: -signed }];
    if (amount === 0) {
      if (existing) await deleteEntry(db, existing.id);
      continue;
    }
    if (existing) {
      await updateEntry(db, existing.id, { date: day, report_date: day }, lines, "開始残高の変更");
      ids.push(existing.id);
    } else {
      ids.push(await createEntry(db, {
        date: day, kind: "opening", payee: `${a.name} 開始残高`, source: "opening", auto_key: autoKey, user_id: c.get("user"),
      }, lines));
    }
  }
  return c.json({ entries: ids });
});

// ---- 取引 ----

async function withLines(db: D1Database, entries: Entry[]) {
  if (entries.length === 0) return [];
  const out = [];
  for (let i = 0; i < entries.length; i += 90) {
    const chunk = entries.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT l.entry_id, l.account_id, l.amount, a.name, a.type, a.kind FROM lines l
        JOIN accounts a ON a.id = l.account_id WHERE l.entry_id IN (${chunk.map(() => "?").join(",")}) ORDER BY l.id`)
      .bind(...chunk.map((e) => e.id))
      .all<{ entry_id: number; account_id: number; amount: number; name: string; type: string; kind: string }>();
    for (const e of chunk) out.push({ ...e, lines: results.filter((l) => l.entry_id === e.id) });
  }
  return out;
}

app.get("/api/entries", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.month) {
    where.push("e.report_date BETWEEN ? AND ?");
    args.push(`${q.month}-01`, `${q.month}-31`);
  }
  if (q.q) {
    where.push("(e.payee LIKE ? OR e.memo LIKE ?)");
    args.push(`%${q.q}%`, `%${q.q}%`);
  }
  if (q.account_id) {
    where.push("EXISTS (SELECT 1 FROM lines l WHERE l.entry_id = e.id AND l.account_id = ?)");
    args.push(Number(q.account_id));
  }
  if (q.provisional) where.push("e.provisional = 1");
  const limit = Math.min(Number(q.limit ?? 500), 1000);
  const { results } = await c.env.DB
    .prepare(`SELECT e.* FROM entries e ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.date DESC, e.id DESC LIMIT ${limit}`)
    .bind(...args)
    .all<Entry>();
  return c.json(await withLines(c.env.DB, results));
});

app.get("/api/entries/:id", async (c) => {
  const { entry } = await getEntry(c.env.DB, int(c.req.param("id"), "id"));
  const [full] = await withLines(c.env.DB, [entry]);
  const { results: recoveries } = await c.env.DB
    .prepare("SELECT * FROM entries WHERE related_entry_id = ? ORDER BY date").bind(entry.id).all<Entry>();
  return c.json({ ...full, recoveries: await withLines(c.env.DB, recoveries) });
});

type EntryInput = SimpleInput & { learn?: boolean };

app.post("/api/entries", async (c) => {
  const env = c.env;
  const input = await c.req.json<EntryInput>();
  let categorySource = "user";
  if (input.kind === "expense" && !input.category_id) {
    // 費目が空ならAIに決めさせる
    const guess = input.payee ? await classifyOne(env, input.payee) : null;
    const fallback = await env.DB.prepare("SELECT id FROM accounts WHERE seed_key = 'other'").first<{ id: number }>();
    input.category_id = guess?.account_id ?? (await resolveAccount(env.DB, fallback!.id)).id;
    categorySource = guess?.source ?? "none";
  }
  const { fields, lines } = await buildSimple(env.DB, input);
  const id = await createEntry(env.DB, { ...fields, source: "manual", category_source: categorySource, user_id: c.get("user") }, lines);
  return c.json({ id, category_id: input.category_id, category_source: categorySource }, 201);
});

app.put("/api/entries/:id", async (c) => {
  const db = c.env.DB;
  const id = int(c.req.param("id"), "id");
  const { entry, lines: oldLines } = await getEntry(db, id);
  const input = await c.req.json<EntryInput>();
  if (!["expense", "income", "transfer"].includes(entry.kind)) {
    // 開始残高、引き落とし、回収、調整は、メモだけ直せる
    await updateEntry(db, id, { memo: input.memo ?? entry.memo });
    return c.json({ id });
  }
  if (entry.source === "statement") {
    // 明細から作った取引は、日付、金額、カードを明細のまま保つ
    const card = oldLines.find((l) => l.amount < 0)!;
    input.date = entry.date;
    input.amount = -card.amount;
    input.from_account_id = card.account_id;
  }
  const { fields, lines } = await buildSimple(db, input);
  if (entry.source === "statement") {
    fields.provisional = 0;
    fields.billing_month = entry.billing_month;
  }
  const oldCategory = oldLines.find((l) => l.amount > 0 && l.account_id !== input.to_account_id)?.account_id;
  const categoryChanged = input.category_id !== undefined && input.category_id !== oldCategory;
  await updateEntry(db, id, { ...fields, category_source: categoryChanged ? "user" : entry.category_source }, lines);
  if (categoryChanged && input.kind === "expense" && input.learn !== false && (input.payee ?? entry.payee)) {
    await learnRule(db, input.payee ?? entry.payee, input.category_id!);
  }
  return c.json({ id });
});

app.delete("/api/entries/:id", async (c) => {
  await deleteEntry(c.env.DB, int(c.req.param("id"), "id"));
  return c.json({ ok: true });
});

// ---- 立て替えと回収 ----

app.get("/api/advances", async (c) => {
  const open = c.req.query("all") ? "" : "AND e.settled = 0";
  const { results } = await c.env.DB
    .prepare(`SELECT e.*,
        (SELECT SUM(l.amount) FROM lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.type = 'expense') AS total,
        COALESCE((SELECT SUM(l.amount) FROM entries r JOIN lines l ON l.entry_id = r.id JOIN accounts a ON a.id = l.account_id
          WHERE r.related_entry_id = e.id AND r.kind = 'recovery' AND a.type = 'asset'), 0) AS recovered
      FROM entries e WHERE e.advance = 1 ${open} ORDER BY e.date DESC`)
    .all<Entry & { total: number; recovered: number }>();
  return c.json(results.map((r) => ({ ...r, remaining: r.total - r.recovered })));
});

/** 回収を記録する。受け取った口座の残高が増え、同じ額だけ元の取引の支出が減る */
app.post("/api/entries/:id/recoveries", async (c) => {
  const db = c.env.DB;
  const { entry, lines } = await getEntry(db, int(c.req.param("id"), "id"));
  if (!entry.advance) throw new LedgerError("立て替えありの取引ではありません");
  const body = await c.req.json<{ date?: string; account_id: number; amount: number; counterparty?: string }>();
  const amount = int(body.amount, "金額");
  if (amount <= 0) throw new LedgerError("受け取った金額を入れてください");
  const to = await resolveAccount(db, int(body.account_id, "受け取った口座"));
  if (to.type !== "asset") throw new LedgerError("受け取った口座を選んでください");
  const ids = lines.map((l) => l.account_id);
  const { results: cats } = await db
    .prepare(`SELECT id FROM accounts WHERE type = 'expense' AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).all<{ id: number }>();
  const expenseLines = lines.filter((l) => cats.some((x) => x.id === l.account_id)).sort((a, b) => b.amount - a.amount);
  if (expenseLines.length === 0) throw new LedgerError("元の取引に支出の費目がありません");
  const id = await createEntry(db, {
    date: body.date ?? todayJST(),
    report_date: entry.report_date,
    kind: "recovery",
    payee: `${entry.payee} の回収`,
    counterparty: body.counterparty ?? null,
    related_entry_id: entry.id,
    user_id: c.get("user"),
  }, [{ account_id: to.id, amount }, { account_id: expenseLines[0].account_id, amount: -amount }]);
  return c.json({ id }, 201);
});

app.post("/api/entries/:id/settle", async (c) => {
  const id = int(c.req.param("id"), "id");
  const { settled } = await c.req.json<{ settled?: boolean }>().catch(() => ({ settled: true }));
  await c.env.DB.prepare("UPDATE entries SET settled = ? WHERE id = ?").bind(settled === false ? 0 : 1, id).run();
  return c.json({ ok: true });
});

// ---- カード明細 ----

app.post("/api/statements/preview", async (c) => {
  const body = await c.req.json<{ account_id: number; billing_month: string; text: string }>();
  return c.json(await previewStatement(c.env, int(body.account_id, "カード"), body.billing_month, body.text ?? ""));
});

app.post("/api/statements/commit", async (c) => {
  const body = await c.req.json<{
    account_id: number; billing_month: string; text: string; file_name?: string;
    choices?: Record<string, { link?: number | "new" | "skip"; category_id?: number }>;
  }>();
  let r2Key: string | undefined;
  if (c.env.BUCKET) {
    r2Key = `statements/${body.account_id}/${body.billing_month}-${Date.now()}.csv`;
    await c.env.BUCKET.put(r2Key, body.text, { httpMetadata: { contentType: "text/csv; charset=utf-8" } });
  }
  return c.json(await commitStatement(c.env, int(body.account_id, "カード"), body.billing_month, body.text ?? "",
    body.choices ?? {}, { file_name: body.file_name, r2_key: r2Key, user_id: c.get("user") }));
});

app.get("/api/statements", async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT s.*, a.name AS account_name FROM statement_imports s JOIN accounts a ON a.id = s.account_id
      ORDER BY s.billing_month DESC, s.id DESC`)
    .all();
  return c.json(results);
});

// ---- 棚卸し ----

/**
 * 実際の残高を入れて、家計簿上の残高との差を出す。adjust が true なら差額を調整の仕訳にする。
 * 調整の相手は、投資の口座なら評価損益、借入なら利息・手数料、それ以外は使途不明。
 */
app.post("/api/balance-checks", async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ account_id: number; date?: string; actual: number; adjust?: boolean }>();
  const a = await getAccount(db, int(body.account_id, "口座"));
  if (a.type !== "asset" && a.type !== "liability") throw new LedgerError("残高を持つ口座を選んでください");
  const date = body.date ?? todayJST();
  const actual = int(body.actual, "残高");
  const book = await balanceOf(db, a, date);
  const diff = actual - book;
  let adjustmentId: number | null = null;
  if (body.adjust && diff !== 0) {
    const counterKey = a.kind === "investment" ? null : a.kind === "loan" ? "interest" : "unknown";
    const counter = counterKey
      ? await db.prepare("SELECT * FROM accounts WHERE seed_key = ?").bind(counterKey).first<Account>()
      : await db.prepare("SELECT * FROM accounts WHERE kind = 'valuation'").first<Account>();
    const signed = a.type === "asset" ? diff : -diff;
    adjustmentId = await createEntry(db, {
      date, kind: "adjustment", payee: `${a.name} 棚卸しの差額`, source: "balance_check", user_id: c.get("user"),
    }, [{ account_id: a.id, amount: signed }, { account_id: (await resolveAccount(db, counter!.id)).id, amount: -signed }]);
  }
  const row = await db
    .prepare(`INSERT INTO balance_checks (account_id, date, actual, book, adjustment_entry_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(a.id, date, actual, book, adjustmentId, c.get("user"))
    .first();
  return c.json({ ...row, diff }, 201);
});

app.get("/api/balance-checks", async (c) => {
  const accountId = c.req.query("account_id");
  const { results } = await c.env.DB
    .prepare(`SELECT b.*, a.name AS account_name FROM balance_checks b JOIN accounts a ON a.id = b.account_id
      ${accountId ? "WHERE b.account_id = ?" : ""} ORDER BY b.date DESC, b.id DESC LIMIT 200`)
    .bind(...(accountId ? [Number(accountId)] : []))
    .all();
  return c.json(results);
});

// ---- 集計 ----

app.get("/api/balances", async (c) => c.json(await balances(c.env.DB)));

app.get("/api/summary/month", async (c) => {
  const month = c.req.query("month") ?? monthOf(todayJST());
  return c.json(await monthSummary(c.env.DB, month));
});

app.get("/api/summary/year", async (c) => {
  const year = c.req.query("year");
  return c.json(await yearSummary(c.env.DB, year ? int(year, "年") : undefined));
});

/** 月末のまとめを作る(作り直す) */
app.post("/api/reports/:month", async (c) => {
  const month = c.req.param("month");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new LedgerError("月は YYYY-MM で入れてください");
  return c.json(await closeMonth(c.env.DB, month));
});

app.get("/api/settings", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return c.json(Object.fromEntries(results.map((r) => [r.key, r.value])));
});

app.put("/api/settings", async (c) => {
  const body = await c.req.json<Record<string, string | number>>();
  const allowed: Record<string, (v: string) => boolean> = {
    year_start_month: (v) => v === "1" || v === "4",
  };
  const stmts = [];
  for (const [k, v] of Object.entries(body)) {
    const value = String(v);
    if (!allowed[k]?.(value)) throw new LedgerError(`設定 ${k} の値が正しくありません`);
    stmts.push(c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(k, value));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ---- レシート読み取りの比較検証 ----

app.post("/api/dev/receipt-eval", async (c) => {
  if (c.env.ENABLE_RECEIPT_EVAL !== "1") return c.json({ error: "比較検証は無効です" }, 404);
  const form = await c.req.formData();
  const file = form.get("image");
  if (!(file instanceof File)) throw new LedgerError("image に画像を付けてください");
  const models = String(form.get("models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return c.json(await evaluateReceipt(c.env, new Uint8Array(await file.arrayBuffer()), file.type || "image/jpeg", models));
});

app.get("/api/health", (c) => c.json({ ok: true, today: todayJST(), next_month: addMonths(monthOf(todayJST()), 1) }));

app.all("/api/*", (c) => c.json({ error: "見つかりません" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(daily(env));
  },
} satisfies ExportedHandler<Env>;

export { app };
