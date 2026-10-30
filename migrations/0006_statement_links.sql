-- 明細の利用先と、利用者が結びつけた取引の内容の対応。次の取り込みで同じ組み合わせを候補に出すのに使う
-- merchant_key は明細の利用先、payee は結びつけた取引の内容。どちらも merchantKey で正規化して持つ
CREATE TABLE statement_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_key TEXT NOT NULL,
  payee TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  user_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merchant_key, payee)
);
