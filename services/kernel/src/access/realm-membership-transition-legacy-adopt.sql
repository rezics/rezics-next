WITH input AS NOT MATERIALIZED (SELECT :operation_id::text AS operation_id, :route::integer AS route, :account_id::uuid AS account_id, :reservation_id::uuid AS reservation_id, :realm_id::uuid AS realm_id, :hold_transaction_id::uuid AS hold_transaction_id), adopted AS (INSERT INTO access.realm_membership_transition
(route,account_id,realm_id,reservation_id,generation_id,operation_id,hold_transaction_id,legacy)
SELECT h.route,h.account_id,h.related_account_id,h.reservation_id,h.reservation_id,(SELECT operation_id FROM input),h.transaction_id,true
FROM access.lifecycle_coordination h
JOIN access.membership_inverse m ON m.route=h.route AND m.account_id=h.account_id AND m.kind='realm'
 AND m.group_id=h.related_account_id AND m.reservation_id=h.reservation_id AND m.transaction_id=h.transaction_id
WHERE h.route=(SELECT route FROM input) AND h.account_id=(SELECT account_id FROM input) AND h.reservation_id=(SELECT reservation_id FROM input)
 AND h.related_account_id=(SELECT realm_id FROM input) AND h.transaction_id=(SELECT hold_transaction_id FROM input) AND h.purpose='membership'
ON CONFLICT (route,account_id,generation_id) DO NOTHING
RETURNING generation_id::text AS "generationId")
SELECT "generationId" FROM adopted UNION ALL
SELECT t.generation_id::text FROM access.realm_membership_transition t
WHERE t.route=(SELECT route FROM input) AND t.account_id=(SELECT account_id FROM input) AND t.generation_id=(SELECT reservation_id FROM input)
 AND t.realm_id=(SELECT realm_id FROM input) AND t.reservation_id=(SELECT reservation_id FROM input)
 AND t.operation_id=(SELECT operation_id FROM input) AND t.hold_transaction_id=(SELECT hold_transaction_id FROM input) AND t.legacy
 AND NOT EXISTS (SELECT 1 FROM adopted);
