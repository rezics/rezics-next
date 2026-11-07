-- One account-leading index contributes at most 100 raw keys to a native page.
SELECT slot_id AS id FROM commerce.benefit_acquisition
WHERE route = :route AND buyer_account_id = :account_id AND slot_id > :after::uuid
ORDER BY slot_id LIMIT 100;
