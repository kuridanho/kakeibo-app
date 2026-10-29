-- 家賃、給与、サブスクなど、決まった日に繰り返す支出、収入、振替
CREATE TABLE recurring (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  amount INTEGER NOT NULL,
  -- 毎月か毎年か。毎年のときは first_date の月に起こる
  every TEXT NOT NULL DEFAULT 'month' CHECK (every IN ('month', 'year')),
  day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  -- 銀行の休みに当たったら翌営業日にずらす
  shift_holiday INTEGER NOT NULL DEFAULT 1,
  first_date TEXT NOT NULL,
  end_date TEXT,
  from_account_id INTEGER REFERENCES accounts (id),
  to_account_id INTEGER REFERENCES accounts (id),
  category_id INTEGER REFERENCES accounts (id),
  payee TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
