// 利用先名からカテゴリを決める。
// 順番は、利用者が直した対応、AIが前に決めた対応、AI、card-usage から移植したキーワード表、その他。
// AIは既存のカテゴリに合うものがなければ新しいカテゴリを提案でき、提案されたカテゴリはその場で作る。
// AIが決めた結果も対応として残し、同じ利用先でAIを何度も呼ばない。

import type { Account, Env } from "../types";
import { guessKeyword } from "./keywords";
import { resolveAccount } from "./ledger";
import { normalizeText } from "./smbc";

export const DEFAULT_CLASSIFY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type CategorySource = "rule" | "ai" | "keyword" | "none";

export interface Classification {
  account_id: number;
  source: CategorySource;
  /** 何の店か分からず、利用者の答えもない。画面で「これは何ですか？」と尋ねる */
  unclear: boolean;
}

export function merchantKey(merchant: string): string {
  return normalizeText(merchant).toUpperCase();
}

async function expenseCategories(db: D1Database): Promise<Account[]> {
  const { results } = await db
    .prepare("SELECT * FROM accounts WHERE type = 'expense' AND archived = 0 AND origin != 'system' ORDER BY sort_order, id")
    .all<Account>();
  return results;
}

async function bySeedKey(db: D1Database, key: string): Promise<Account | null> {
  const a = await db.prepare("SELECT * FROM accounts WHERE seed_key = ?").bind(key).first<Account>();
  return a ? resolveAccount(db, a.id) : null;
}

/** 利用者がカテゴリを直したときに対応を覚える */
export async function learnRule(db: D1Database, merchant: string, accountId: number): Promise<void> {
  const pattern = merchantKey(merchant);
  if (!pattern) return;
  await db
    .prepare(`INSERT INTO category_rules (pattern, match, account_id, origin) VALUES (?, 'exact', ?, 'user')
      ON CONFLICT (pattern, match) DO UPDATE SET account_id = excluded.account_id, origin = 'user'`)
    .bind(pattern, accountId)
    .run();
}

interface AIAnswer {
  i: number;
  category: string;
}

const UNCLEAR = "不明";

async function askAI(env: Env, merchants: string[], categories: Account[]): Promise<AIAnswer[] | null> {
  if (!env.AI || merchants.length === 0) return null;
  const system = [
    "家計簿の支出のカテゴリを、クレジットカード明細や手入力の利用先名から決める。",
    "利用先名は省略や英字、全角半角の混在があり、末尾に「/NFC」「/ID」や決済代行の名前が付くことがある。",
    `今あるカテゴリ: ${categories.map((c) => c.name).join("、")}`,
    "できるだけ今あるカテゴリから選ぶ。どれにも当てはまらず、今後も同じ種類の支出が続きそうなときだけ、短い日本語の新しいカテゴリ名を答える。",
    "利用者の答えが括弧で付いていれば、それを手がかりにする。",
    "名前から何の店か判断できないときは、推測せずに「不明」と答える。",
    '答えは {"results":[{"i":番号,"category":"カテゴリ名"}]} のJSONだけにする。',
  ].join("\n");
  const user = merchants.map((m, i) => `${i}: ${m}`).join("\n");
  try {
    const out = (await env.AI.run((env.CLASSIFY_MODEL || DEFAULT_CLASSIFY_MODEL) as keyof AiModels, {
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: 40 + merchants.length * 30,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: { i: { type: "integer" }, category: { type: "string" } },
                required: ["i", "category"],
              },
            },
          },
          required: ["results"],
        },
      },
    } as never)) as { response?: unknown };
    const raw = out?.response;
    const parsed = typeof raw === "string" ? JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) : raw;
    const results = (parsed as { results?: AIAnswer[] })?.results;
    return Array.isArray(results) ? results : null;
  } catch (e) {
    console.error("カテゴリのAI判断に失敗しました", e);
    return null;
  }
}

/** AIの答えたカテゴリ名を、今あるカテゴリか新しく作ったカテゴリに当てる */
async function categoryForName(db: D1Database, name: string, categories: Account[]): Promise<Account | null> {
  const cleaned = name.trim().slice(0, 20);
  if (!cleaned) return null;
  const found = categories.find((c) => c.name === cleaned);
  if (found) return found;
  const merged = await db
    .prepare("SELECT * FROM accounts WHERE type = 'expense' AND name = ?").bind(cleaned).first<Account>();
  if (merged) return resolveAccount(db, merged.id);
  const created = await db
    .prepare(`INSERT INTO accounts (name, type, kind, origin, sort_order)
      VALUES (?, 'expense', 'category', 'ai', (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM accounts WHERE type = 'expense' AND origin != 'system'))
      RETURNING *`)
    .bind(cleaned)
    .first<Account>();
  categories.push(created!);
  return created;
}

export async function classifyMerchants(env: Env, merchants: string[]): Promise<Map<string, Classification>> {
  const db = env.DB;
  const result = new Map<string, Classification>();
  const keys = [...new Set(merchants.map(merchantKey).filter(Boolean))];
  const unknown: string[] = [];

  const { results: rules } = await db
    .prepare("SELECT pattern, match, account_id, origin FROM category_rules")
    .all<{ pattern: string; match: string; account_id: number; origin: string }>();
  const exact = new Map(rules.filter((r) => r.match === "exact").map((r) => [r.pattern, r]));
  const contains = rules.filter((r) => r.match === "contains").sort((a, b) => b.pattern.length - a.pattern.length);
  // 「これは何ですか？」への利用者の答え
  const { results: noted } = await db
    .prepare("SELECT pattern, note FROM merchant_names WHERE note IS NOT NULL AND note != ''")
    .all<{ pattern: string; note: string }>();
  const notes = new Map(noted.map((n) => [n.pattern, n.note]));
  const other = await bySeedKey(db, "other");

  for (const key of keys) {
    const rule = exact.get(key) ?? contains.find((r) => key.includes(r.pattern));
    if (rule) {
      const a = await resolveAccount(db, rule.account_id);
      // AIが前に「その他」としか決められなかった店は、答えがなければ尋ねる
      const unclear = rule.origin === "ai" && a.id === other?.id && !notes.has(key);
      result.set(key, { account_id: a.id, source: rule.origin === "ai" ? "ai" : "rule", unclear });
    } else {
      unknown.push(key);
    }
  }

  if (unknown.length > 0) {
    const categories = await expenseCategories(db);
    // 1回の問い合わせが長くなりすぎないよう、40件ずつに分ける
    for (let start = 0; start < unknown.length; start += 40) {
      const chunk = unknown.slice(start, start + 40);
      const answers = await askAI(env, chunk.map((k) => notes.has(k) ? `${k}（利用者の答え: ${notes.get(k)}）` : k), categories);
      for (const ans of answers ?? []) {
        const key = chunk[ans.i];
        if (key === undefined || result.has(key)) continue;
        // 分からないものは覚えず、利用者に尋ねる
        if (String(ans.category ?? "").trim() === UNCLEAR) continue;
        const a = await categoryForName(db, String(ans.category ?? ""), categories);
        if (!a) continue;
        result.set(key, { account_id: a.id, source: "ai", unclear: false });
        await db
          .prepare("INSERT OR IGNORE INTO category_rules (pattern, match, account_id, origin) VALUES (?, 'exact', ?, 'ai')")
          .bind(key, a.id)
          .run();
      }
    }
  }

  for (const key of unknown) {
    if (result.has(key)) continue;
    const seed = guessKeyword(key) ?? (notes.has(key) ? guessKeyword(notes.get(key)!) : null);
    const a = seed ? await bySeedKey(db, seed) : null;
    if (a) result.set(key, { account_id: a.id, source: "keyword", unclear: false });
    else if (other) result.set(key, { account_id: other.id, source: "none", unclear: !notes.has(key) });
  }
  return result;
}

export async function classifyOne(env: Env, merchant: string): Promise<Classification | null> {
  const key = merchantKey(merchant);
  if (!key) return null;
  return (await classifyMerchants(env, [merchant])).get(key) ?? null;
}

// ---- レシートの品目 ----
// 品目名は店名と混ざらないよう、頭に ITEM: を付けて対応を覚える。

const ITEM_PREFIX = "ITEM:";

export async function learnItemRule(db: D1Database, name: string, accountId: number): Promise<void> {
  const key = merchantKey(name);
  if (key) await learnRule(db, `${ITEM_PREFIX}${key}`, accountId);
}

export interface ItemClassification {
  category_id: number | null;
  category_source: CategorySource;
  /** AIにも品目が何か分からなかった。画面で「これは何ですか？」と尋ねる */
  unclear: boolean;
}

export async function classifyItems(env: Env, names: string[]): Promise<ItemClassification[]> {
  const db = env.DB;
  const out: ItemClassification[] = names.map(() => ({ category_id: null, category_source: "none", unclear: true }));
  const { results: rules } = await db
    .prepare("SELECT pattern, account_id, origin FROM category_rules WHERE pattern LIKE 'ITEM:%'")
    .all<{ pattern: string; account_id: number; origin: string }>();
  const known = new Map(rules.map((r) => [r.pattern.slice(ITEM_PREFIX.length), r]));
  const ask: number[] = [];
  for (const [i, name] of names.entries()) {
    const rule = known.get(merchantKey(name));
    if (rule) out[i] = { category_id: (await resolveAccount(db, rule.account_id)).id, category_source: "rule", unclear: false };
    else ask.push(i);
  }
  if (ask.length === 0 || !env.AI) return out;

  const categories = await expenseCategories(db);
  const system = [
    "日本のレシートの品目名から、家計簿の支出のカテゴリを決める。品目名は略されていたり、カタカナや英字だったりする。",
    `カテゴリ: ${categories.map((c) => c.name).join("、")}`,
    "必ずこの中から選ぶ。品目が何か見当がつかないときは category を「不明」にする。",
    '答えは {"results":[{"i":番号,"category":"カテゴリ名"}]} のJSONだけにする。',
  ].join("\n");
  try {
    const res = (await env.AI.run((env.CLASSIFY_MODEL || DEFAULT_CLASSIFY_MODEL) as keyof AiModels, {
      messages: [{ role: "system", content: system }, { role: "user", content: ask.map((i, n) => `${n}: ${names[i]}`).join("\n") }],
      max_tokens: 40 + ask.length * 30,
      temperature: 0,
    } as never)) as { response?: unknown };
    const raw = res?.response;
    const parsed = typeof raw === "string" ? JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) : raw;
    for (const ans of (parsed as { results?: AIAnswer[] })?.results ?? []) {
      const i = ask[ans.i];
      const cat = categories.find((c) => c.name === String(ans.category ?? "").trim());
      if (i !== undefined && cat) out[i] = { category_id: cat.id, category_source: "ai", unclear: false };
    }
  } catch (e) {
    console.error("品目のカテゴリのAI判断に失敗しました", e);
  }
  return out;
}
