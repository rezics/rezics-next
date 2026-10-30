WITH adopted AS (INSERT INTO access.realm_membership_transition
(route,account_id,realm_id,reservation_id,generation_id,operation_id,hold_transaction_id,legacy)
SELECT h.route,h.account_id,h.related_account_id,h.reservation_id,h.reservation_id,:operation_id::text,h.transaction_id,true
FROM access.lifecycle_coordination h
JOIN access.membership_inverse m ON m.route=h.route AND m.account_id=h.account_id AND m.kind='realm'
 AND m.group_id=h.related_account_id AND m.reservation_id=h.reservation_id AND m.transaction_id=h.transaction_id
WHERE h.route=:route::integer AND h.account_id=:account_id::uuid AND h.reservation_id=:reservation_id::uuid
 AND h.related_account_id=:realm_id::uuid AND h.transaction_id=:hold_transaction_id::uuid AND h.purpose='membership'
ON CONFLICT (route,account_id,generation_id) DO NOTHING
RETURNING generation_id::text AS "generationId")
SELECT "generationId" FROM adopted UNION ALL
SELECT t.generation_id::text FROM access.realm_membership_transition t
WHERE t.route=:route::integer AND t.account_id=:account_id::uuid AND t.generation_id=:reservation_id::uuid
 AND t.realm_id=:realm_id::uuid AND t.reservation_id=:reservation_id::uuid
 AND t.operation_id=:operation_id::text AND t.hold_transaction_id=:hold_transaction_id::uuid AND t.legacy
 AND NOT EXISTS (SELECT 1 FROM adopted);
