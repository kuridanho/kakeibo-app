-- カードの分割払い。毎月の支払いは、その回が請求に載る日に取引として記録する。
-- 支払額のうち利用額を割った分はカテゴリへ、残りは利息・手数料へ入れる
CREATE TABLE installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES accounts (id),
  category_id INTEGER NOT NULL REFERENCES accounts (id),
  payee TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  -- 利用日
  purchase_date TEXT NOT NULL,
  -- 利用額。手数料は含めない
  principal INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 2),
  -- 1回目の請求月 YYYY-MM
  first_month TEXT NOT NULL,
  -- 1回目と2回目以降の支払額。明細を取り込むと実際の額に合わせる
  first_payment INTEGER NOT NULL,
  payment INTEGER NOT NULL,
  -- この回より前は記録しない。明細で途中の回から見つけた分割に使う
  start_number INTEGER NOT NULL DEFAULT 1,
  -- manual(記録のときに分割) / later(あとから分割) / statement(明細で見つけた)
  origin TEXT NOT NULL DEFAULT 'manual',
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX installments_card ON installments (card_id);
