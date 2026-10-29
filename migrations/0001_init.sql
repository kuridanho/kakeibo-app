-- 家計簿の初期スキーマ。複式簿記で記録する。
-- user_id は将来家族と共有するときのための利用者id。Cloudflare Access のメールアドレスを入れる。
-- 今は一人で使うので、読み出しでは絞り込まない。
-- 金額はすべて円の整数。仕訳の明細行(lines)は借方を正、貸方を負で持ち、1つの仕訳の合計は0になる。

-- 口座と費目。費目も口座の一種として同じ表に置く。
--   type: asset(資産) / liability(負債) / equity(純資産) / income(収入の費目) / expense(支出の費目)
--   kind: asset なら cash, bank, emoney, savings, investment, receivable。liability なら card, loan。
--         equity なら opening, valuation。income と expense なら category。
--   investment(投資信託や証券)は手元の現金とは別枠で、売買を振替として記録し、評価額の変化は valuation に入れる。
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  kind TEXT NOT NULL,
  -- 手元の現金に数えるか。財布、普通預金、電子マネーは1、定期預金や証券は0
  liquid INTEGER NOT NULL DEFAULT 0,
  -- カードの締め日と引き落とし日。31は月末を表す
  closing_day INTEGER,
  payment_day INTEGER,
  -- カードや借入の引き落とし口座
  payment_account_id INTEGER REFERENCES accounts(id),
  -- 借入の毎月の返済額
  payment_amount INTEGER,
  -- 棚卸しの間隔(日)。空なら知らせない
  check_interval_days INTEGER,
  -- 明細CSVの名義行に出るカード名。取り込み時に口座を当てるのに使う
  statement_card_name TEXT,
  -- カードの明細を取り込むか。0なら家賃用のカードのように明細を取り込まず、手入力をそのまま確定にする
  statement_import INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- seed(初期値) / user(利用者が作成) / ai(AIが提案して作成) / system(アプリが使う)
  origin TEXT NOT NULL DEFAULT 'user',
  -- 初期の費目がcard-usageのどの分類にあたるか。キーワード表の結果を費目に当てるのに使う
  seed_key TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  merged_into_id INTEGER REFERENCES accounts(id),
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 仕訳。画面上の取引1件にあたる。
CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  -- 利用日
  date TEXT NOT NULL,
  -- 集計に使う日。回収は元の取引の日になる
  report_date TEXT NOT NULL,
  -- expense / income / transfer / opening / adjustment / recovery / card_payment
  kind TEXT NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  -- manual / statement / receipt / balance_check / opening / auto
  source TEXT NOT NULL DEFAULT 'manual',
  -- カード払いの手入力は明細と照合するまで仮
  provisional INTEGER NOT NULL DEFAULT 0,
  -- カードの請求月 YYYY-MM
  billing_month TEXT,
  statement_import_id INTEGER REFERENCES statement_imports(id),
  -- 明細の行を二重に取り込まないための鍵
  statement_key TEXT,
  -- 費目をどう決めたか: user / rule / ai / keyword / none
  category_source TEXT,
  -- 立て替えあり、精算済み
  advance INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 0,
  -- 回収の元になった取引
  related_entry_id INTEGER REFERENCES entries(id) ON DELETE CASCADE,
  counterparty TEXT,
  -- カードの引き落としなど、口座と月で一度だけ作る自動仕訳の鍵
  auto_key TEXT UNIQUE,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX entries_report_date ON entries(report_date);
CREATE INDEX entries_billing ON entries(billing_month);
CREATE UNIQUE INDEX entries_statement_key ON entries(statement_key) WHERE statement_key IS NOT NULL;
CREATE INDEX entries_related ON entries(related_entry_id);

CREATE TABLE lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL
);
CREATE INDEX lines_entry ON lines(entry_id);
CREATE INDEX lines_account ON lines(account_id);

-- 費目の対応。利用者の修正とAIの判断を残し、次からはAIより先に当てる。
CREATE TABLE category_rules (
  id INTEGER PRIMARY KEY,
  -- 正規化した利用先名
  pattern TEXT NOT NULL,
  -- exact(完全一致) / contains(部分一致)
  match TEXT NOT NULL DEFAULT 'exact',
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  -- user / ai
  origin TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pattern, match)
);

CREATE TABLE statement_imports (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  billing_month TEXT NOT NULL,
  declared_total INTEGER,
  imported_total INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  file_name TEXT,
  r2_key TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE balance_checks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  actual INTEGER NOT NULL,
  book INTEGER NOT NULL,
  adjustment_entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 月末のまとめ。作った時点の費目ごとの合計を残し、後から変わった額を出す。
CREATE TABLE month_reports (
  month TEXT PRIMARY KEY,
  totals TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 取引の変更の記録。まとめの後に何が変わったかを示すのに使う。
CREATE TABLE entry_changes (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER,
  -- create / update / delete / merge_category
  action TEXT NOT NULL,
  -- 影響した集計月(YYYY-MM)のJSON配列
  months TEXT NOT NULL,
  -- 費目ごとの増減 {"account_id": amount}
  delta TEXT NOT NULL,
  summary TEXT NOT NULL,
  user_id TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX entry_changes_at ON entry_changes(at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('year_start_month', '1');

INSERT INTO accounts (name, type, kind, origin, sort_order) VALUES
  ('開始残高', 'equity', 'opening', 'system', 0),
  ('評価損益', 'equity', 'valuation', 'system', 10);

INSERT INTO accounts (name, type, kind, origin, seed_key, sort_order) VALUES
  ('コンビニ', 'expense', 'category', 'seed', 'convenience', 10),
  ('食料品', 'expense', 'category', 'seed', 'groceries', 20),
  ('外食', 'expense', 'category', 'seed', 'dining', 30),
  ('買い物', 'expense', 'category', 'seed', 'shopping', 40),
  ('交通', 'expense', 'category', 'seed', 'transport', 50),
  ('光熱費', 'expense', 'category', 'seed', 'utilities', 60),
  ('通信', 'expense', 'category', 'seed', 'telecom', 70),
  ('サブスク', 'expense', 'category', 'seed', 'subscription', 80),
  ('趣味・娯楽', 'expense', 'category', 'seed', 'entertainment', 90),
  ('美容', 'expense', 'category', 'seed', 'beauty', 100),
  ('投資', 'expense', 'category', 'seed', 'investment', 110),
  ('その他', 'expense', 'category', 'seed', 'other', 120),
  ('使途不明', 'expense', 'category', 'system', 'unknown', 900),
  ('利息・手数料', 'expense', 'category', 'seed', 'interest', 910);

INSERT INTO accounts (name, type, kind, origin, seed_key, sort_order) VALUES
  ('給与', 'income', 'category', 'seed', 'salary', 10),
  ('その他の収入', 'income', 'category', 'seed', 'other_income', 20);
