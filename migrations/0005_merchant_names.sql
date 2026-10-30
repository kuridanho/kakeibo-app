-- 明細の利用先名の覚え書き。取り込みで店名を直したときの置き換え先と、何の店かの答えを残す。
-- 置き換えは次の取り込みで自動では当てず、行ごとに提案して確かめる。
CREATE TABLE merchant_names (
  -- 正規化した明細の利用先名
  pattern TEXT PRIMARY KEY,
  -- 利用者が付けた店名。何の店かだけ答えたときは空
  name TEXT,
  -- 「これは何ですか？」への答え。カテゴリを決めるときにAIへ渡す
  note TEXT,
  user_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
