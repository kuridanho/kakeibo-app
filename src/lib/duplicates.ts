// 同じ支払いを二重に記録したかもしれない取引。明細から取り込んだ取引と、同じカードで同じ金額の手入力が近い日にあれば知らせる。
// 別の取引だと答えた組は settings の duplicate_dismissed に覚え、もう出さない。

import { getSetting } from "./reports";

/** 明細の取引と手入力の取引の日付の差がこの日数までなら、重複かもしれないとみなす */
export const DUPLICATE_DAYS = 45;

export interface DuplicatePair {
  statement: { id: number; date: string; payee: string };
  manual: { id: number; date: string; payee: string; provisional: number };
  account_id: number;
  account_name: string;
  amount: number;
}

const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

async function dismissed(db: D1Database): Promise<Set<string>> {
  try {
    return new Set(JSON.parse(await getSetting(db, "duplicate_dismissed", "[]")) as string[]);
  } catch {
    return new Set();
  }
}

export async function findDuplicates(db: D1Database): Promise<DuplicatePair[]> {
  // 支出1件ごとの、払ったカードと額(カードの行)
  const { results } = await db
    .prepare(`SELECT s.id AS sid, s.date AS sdate, s.payee AS spayee, m.id AS mid, m.date AS mdate, m.payee AS mpayee,
        m.provisional AS mprov, sl.account_id, a.name AS account_name, -sl.amount AS amount
      FROM entries s JOIN lines sl ON sl.entry_id = s.id JOIN accounts a ON a.id = sl.account_id
      JOIN lines ml ON ml.account_id = sl.account_id AND ml.amount = sl.amount
      JOIN entries m ON m.id = ml.entry_id
      WHERE a.kind = 'card' AND sl.amount < 0 AND s.kind = 'expense' AND m.kind = 'expense'
        AND s.statement_key IS NOT NULL AND m.statement_key IS NULL AND m.auto_key IS NULL
        AND ABS(julianday(s.date) - julianday(m.date)) <= ?
      ORDER BY m.date DESC, s.date`)
    .bind(DUPLICATE_DAYS)
    .all<{ sid: number; sdate: string; spayee: string; mid: number; mdate: string; mpayee: string; mprov: number;
      account_id: number; account_name: string; amount: number }>();
  const skip = await dismissed(db);
  const seen = new Set<number>();
  const out: DuplicatePair[] = [];
  for (const r of results) {
    // 手入力1件には、いちばん近い明細の取引を1つだけ出す
    if (seen.has(r.mid) || skip.has(pairKey(r.sid, r.mid))) continue;
    seen.add(r.mid);
    out.push({
      statement: { id: r.sid, date: r.sdate, payee: r.spayee },
      manual: { id: r.mid, date: r.mdate, payee: r.mpayee, provisional: r.mprov },
      account_id: r.account_id, account_name: r.account_name, amount: r.amount,
    });
  }
  return out;
}

/** 別の取引だと答えた組を覚える */
export async function dismissDuplicate(db: D1Database, a: number, b: number) {
  const keys = await dismissed(db);
  keys.add(pairKey(a, b));
  await db.prepare(`INSERT INTO settings (key, value) VALUES ('duplicate_dismissed', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify([...keys])).run();
}

/** 取引 id と統合できそうな取引。種類と額が同じで、日付が近いもの */
export async function mergeCandidates(db: D1Database, id: number) {
  const { results } = await db
    .prepare(`WITH t AS (SELECT e.id, e.date, e.kind, (SELECT SUM(amount) FROM lines WHERE entry_id = e.id AND amount > 0) AS amount
        FROM entries e WHERE e.id = ?)
      SELECT e.id, e.date, e.payee, e.provisional, e.statement_key IS NOT NULL AS from_statement,
        (SELECT GROUP_CONCAT(a.name, '、') FROM lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id = e.id AND l.amount < 0 AND a.type IN ('asset', 'liability')) AS paid_with,
        (SELECT SUM(amount) FROM lines WHERE entry_id = e.id AND amount > 0) AS amount
      FROM entries e, t
      WHERE e.id != t.id AND e.kind = t.kind AND e.kind IN ('expense', 'income', 'transfer')
        AND (e.auto_key IS NULL OR e.auto_key NOT LIKE 'installment:%')
        AND ABS(julianday(e.date) - julianday(t.date)) <= ?
        AND (SELECT SUM(amount) FROM lines WHERE entry_id = e.id AND amount > 0) = t.amount
      ORDER BY ABS(julianday(e.date) - julianday(t.date)), e.id DESC LIMIT 20`)
    .bind(id, DUPLICATE_DAYS)
    .all<{ id: number; date: string; payee: string; provisional: number; from_statement: number; paid_with: string | null; amount: number }>();
  return results;
}
