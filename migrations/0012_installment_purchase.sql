-- 分割払いは購入した日に利用額の全額を支出にし、毎月の回は手数料だけを支出にする。
-- 購入の取引はカテゴリと「分割払い」(まだ請求に載っていない分割の利用額)の間で記録し、
-- 毎月の回は「分割払い」からカードの請求へ移す。カードの未払いと引き落とし額は今までと同じ。
INSERT INTO accounts (name, type, kind, origin, seed_key, sort_order) VALUES
  ('分割払い', 'equity', 'deferred', 'system', 'installment_deferred', 20);

-- 記録済みの回の利用額の分を、カテゴリから「分割払い」へ移す
UPDATE lines SET account_id = (SELECT id FROM accounts WHERE seed_key = 'installment_deferred')
WHERE entry_id IN (SELECT id FROM entries WHERE auto_key LIKE 'installment:%')
  AND account_id IN (SELECT id FROM accounts WHERE type = 'expense' AND COALESCE(seed_key, '') != 'interest');

-- 購入の取引。使い始める前に買ったものは使い始めた日に、記録する回の利用額だけを数える。
-- 端数の細かい合わせは、毎日の処理(syncPurchases)で直す
INSERT INTO entries (date, report_date, kind, payee, memo, source, provisional, auto_key, category_source, user_id)
SELECT d, d, 'expense', i.payee, TRIM(i.memo || ' 分割 ' || i.count || '回払いで購入'), 'installment', 0,
  'installment:' || i.id || ':purchase', 'user', i.user_id
FROM (SELECT i.*, MAX(i.purchase_date, COALESCE((SELECT MIN(date) FROM entries WHERE kind = 'opening'), i.purchase_date)) AS d
  FROM installments i) i;

INSERT INTO lines (entry_id, account_id, amount)
SELECT e.id, COALESCE(a.merged_into_id, a.id),
  i.principal - CASE WHEN i.start_number > 1
    THEN (i.principal - (i.principal / i.count) * (i.count - 1)) + (i.principal / i.count) * (i.start_number - 2) ELSE 0 END
FROM installments i JOIN entries e ON e.auto_key = 'installment:' || i.id || ':purchase'
  JOIN accounts a ON a.id = i.category_id;

INSERT INTO lines (entry_id, account_id, amount)
SELECT e.id, (SELECT id FROM accounts WHERE seed_key = 'installment_deferred'), -l.amount
FROM entries e JOIN lines l ON l.entry_id = e.id
WHERE e.auto_key LIKE 'installment:%:purchase';
