// 明細の利用先名の覚え書き。
// 取り込みで店名を直すと、明細の利用先名から直した名前への置き換えを覚える。
// 次の取り込みでは置き換えを勝手に当てず、行ごとに候補として出して確かめる。
// 何の店か分からない利用先に利用者が答えたら、その答えも覚えてカテゴリの判断に使う。

import { merchantKey } from "./classify";

export interface MerchantMemo {
  pattern: string;
  name: string | null;
  note: string | null;
}

export async function merchantMemos(db: D1Database): Promise<MerchantMemo[]> {
  const { results } = await db.prepare("SELECT pattern, name, note FROM merchant_names").all<MerchantMemo>();
  return results;
}

/**
 * 明細の利用先名に合う置き換えの候補。
 * 同じ利用先名で直したことがあればその名前を出す。
 * 「STARBUCKS 仙台駅前店」を「STARBUCKS」にしたように、頭の部分だけを残す直し方なら、
 * 同じ頭で始まる別の店(「STARBUCKS 長町店」など)にも同じ名前を候補として出す。
 */
export function suggestName(merchant: string, memos: MerchantMemo[]): string | null {
  const key = merchantKey(merchant);
  if (!key) return null;
  const exact = memos.find((m) => m.pattern === key && m.name);
  if (exact) return merchantKey(exact.name!) === key ? null : exact.name;
  let best: string | null = null;
  for (const m of memos) {
    if (!m.name) continue;
    const head = merchantKey(m.name);
    if (head.length < 2 || !m.pattern.startsWith(head) || !key.startsWith(head)) continue;
    if (!best || head.length > merchantKey(best).length) best = m.name;
  }
  return best && merchantKey(best) !== key ? best : null;
}

export async function rememberName(db: D1Database, merchant: string, name: string, userId: string | null) {
  const pattern = merchantKey(merchant);
  if (!pattern) return;
  await db
    .prepare(`INSERT INTO merchant_names (pattern, name, user_id) VALUES (?, ?, ?)
      ON CONFLICT (pattern) DO UPDATE SET name = excluded.name, updated_at = datetime('now')`)
    .bind(pattern, name, userId)
    .run();
}

export async function rememberNote(db: D1Database, merchant: string, note: string, userId: string | null) {
  const pattern = merchantKey(merchant);
  if (!pattern) return;
  await db
    .prepare(`INSERT INTO merchant_names (pattern, note, user_id) VALUES (?, ?, ?)
      ON CONFLICT (pattern) DO UPDATE SET note = excluded.note, updated_at = datetime('now')`)
    .bind(pattern, note, userId)
    .run();
}
