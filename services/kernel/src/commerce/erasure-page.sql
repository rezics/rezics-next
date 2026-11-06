-- One account-leading index contributes at most 100 raw keys to a native page.
SELECT entitlement_id AS id FROM commerce.entitlement
WHERE route = :route AND account_id = :account_id AND entitlement_id > :after::uuid
ORDER BY entitlement_id LIMIT 100;
