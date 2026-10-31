-- 借入の年率(%)。定額払いやキャッシングの利息を、日割りで返済に含めて記録するのに使う
ALTER TABLE accounts ADD COLUMN annual_rate REAL;
