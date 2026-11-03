-- 借入の返済期限。返済日を決めない借入で、期限の1週間前からホームで知らせる
ALTER TABLE accounts ADD COLUMN due_date TEXT;
