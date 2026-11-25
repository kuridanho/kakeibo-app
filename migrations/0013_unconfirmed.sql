-- 繰り返しが自動で記録した取引は、その日にホームの確認することへ出し、本人が確かめるまで未確認とする
ALTER TABLE entries ADD COLUMN unconfirmed INTEGER NOT NULL DEFAULT 0;

-- 本日(2026-11-26)以降に自動で記録した繰り返しの回は未確認にする
UPDATE entries SET unconfirmed = 1 WHERE source = 'recurring' AND date >= '2026-11-26';
