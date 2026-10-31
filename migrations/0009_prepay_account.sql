-- カードや借入の引き落としで、引き落とし口座より先に残高から引く口座。メルペイ残高のように、
-- 先にその口座の残高から引き、足りない分だけ引き落とし口座から引く
ALTER TABLE accounts ADD COLUMN prepay_account_id INTEGER REFERENCES accounts(id);
