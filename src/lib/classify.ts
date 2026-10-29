// 利用先名から費目を決める。
// 順番は、利用者が直した対応、AIが前に決めた対応、AI、card-usage から移植したキーワード表、その他。
// AIは既存の費目に合うものがなければ新しい費目を提案でき、提案された費目はその場で作る。
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

/** 利用者が費目を直したときに対応を覚える */
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

async function askAI(env: Env, merchants: string[], categories: Account[]): Promise<AIAnswer[] | null> {
  if (!env.AI || merchants.length === 0) return null;
  const system = [
    "家計簿の支出の費目を、クレジットカード明細や手入力の利用先名から決める。",
    "利用先名は省略や英字、全角半角の混在があり、末尾に「/NFC」「/ID」や決済代行の名前が付くことがある。",
    `今ある費目: ${categories.map((c) => c.name).join("、")}`,
    "できるだけ今ある費目から選ぶ。どれにも当てはまらず、今後も同じ種類の支出が続きそうなときだけ、短い日本語の新しい費目名を答える。",
    "店がわからないときは「その他」にする。",
    '答えは {"results":[{"i":番号,"category":"費目名"}]} のJSONだけにする。',
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
    console.error("費目のAI判断に失敗しました", e);
    return null;
  }
}

/** AIの答えた費目名を、今ある費目か新しく作った費目に当てる */
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

  for (const key of keys) {
    const rule = exact.get(key) ?? contains.find((r) => key.includes(r.pattern));
    if (rule) {
      const a = await resolveAccount(db, rule.account_id);
      result.set(key, { account_id: a.id, source: rule.origin === "ai" ? "ai" : "rule" });
    } else {
      unknown.push(key);
    }
  }

  if (unknown.length > 0) {
    const categories = await expenseCategories(db);
    // 1回の問い合わせが長くなりすぎないよう、40件ずつに分ける
    for (let start = 0; start < unknown.length; start += 40) {
      const chunk = unknown.slice(start, start + 40);
      const answers = await askAI(env, chunk, categories);
      for (const ans of answers ?? []) {
        const key = chunk[ans.i];
        if (key === undefined || result.has(key)) continue;
        const a = await categoryForName(db, String(ans.category ?? ""), categories);
        if (!a) continue;
        result.set(key, { account_id: a.id, source: "ai" });
        await db
          .prepare("INSERT OR IGNORE INTO category_rules (pattern, match, account_id, origin) VALUES (?, 'exact', ?, 'ai')")
          .bind(key, a.id)
          .run();
      }
    }
  }

  const other = await bySeedKey(db, "other");
  for (const key of unknown) {
    if (result.has(key)) continue;
    const seed = guessKeyword(key);
    const a = seed ? await bySeedKey(db, seed) : null;
    if (a) result.set(key, { account_id: a.id, source: "keyword" });
    else if (other) result.set(key, { account_id: other.id, source: "none" });
  }
  return result;
}

export async function classifyOne(env: Env, merchant: string): Promise<Classification | null> {
  const key = merchantKey(merchant);
  if (!key) return null;
  return (await classifyMerchants(env, [merchant])).get(key) ?? null;
}
