-- 記録の画面で支払方法として選べるかどうか。財布、銀行口座、電子マネー、カードは最初から選べる
ALTER TABLE accounts ADD COLUMN pay_method INTEGER NOT NULL DEFAULT 1;
UPDATE accounts SET pay_method = 0 WHERE kind NOT IN ('cash', 'bank', 'emoney', 'card');
