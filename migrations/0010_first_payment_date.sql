-- 借入の最初の返済日。この日の月より前の返済は記録せず、予定にも出さない
ALTER TABLE accounts ADD COLUMN first_payment_date TEXT;
