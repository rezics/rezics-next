-- 100 UUID raw keys (1,600 bytes); children are removed before any parent minimization.
SELECT entitlement_id AS id FROM commerce.entitlement
WHERE route = :route::integer AND account_id = :account_id::uuid AND entitlement_id > :after::uuid
ORDER BY entitlement_id LIMIT 100;
