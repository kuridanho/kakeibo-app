-- 繰り返しでない、一度きりの支出、収入、振替の予定。その日が来たら確かめて記録にする
CREATE TABLE planned (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  amount INTEGER NOT NULL,
  date TEXT NOT NULL,
  from_account_id INTEGER REFERENCES accounts (id),
  to_account_id INTEGER REFERENCES accounts (id),
  category_id INTEGER REFERENCES accounts (id),
  payee TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  -- 確かめて記録した取引。記録するまでは空
  entry_id INTEGER REFERENCES entries (id),
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX planned_open ON planned (date) WHERE entry_id IS NULL;
