-- Consumption locks the same account as tombstone. Replay never spends another generation.
WITH consumed AS (
 UPDATE access.realm_membership_transition t
 SET proof_transaction_id=:proof_transaction_id::uuid, outcome=:outcome::text,
     consumed_transaction_id=:transaction_id::uuid
 WHERE t.route=:route::integer AND t.account_id=:account_id::uuid AND t.realm_id=:realm_id::uuid
 AND t.reservation_id=:reservation_id::uuid AND t.generation_id=:generation_id::uuid
 AND t.operation_id=:operation_id::text AND t.proof_transaction_id IS NULL
 AND EXISTS (SELECT 1 FROM access.lifecycle_coordination h
   WHERE h.route=t.route AND h.account_id=t.account_id AND h.reservation_id=t.generation_id
   AND h.related_account_id=t.realm_id AND h.purpose='membership' AND h.transaction_id=t.hold_transaction_id)
 RETURNING *
), released AS (
 DELETE FROM access.lifecycle_coordination h USING consumed t
 WHERE h.route=t.route AND h.account_id=t.account_id AND h.reservation_id=t.generation_id
 AND h.related_account_id=t.realm_id AND h.purpose='membership' AND h.transaction_id=t.hold_transaction_id
 RETURNING h.reservation_id
)
SELECT generation_id::text AS "generationId" FROM consumed WHERE EXISTS (SELECT 1 FROM released)
UNION ALL
SELECT generation_id::text FROM access.realm_membership_transition
WHERE route=:route::integer AND account_id=:account_id::uuid AND realm_id=:realm_id::uuid
 AND reservation_id=:reservation_id::uuid AND generation_id=:generation_id::uuid AND operation_id=:operation_id::text
 AND proof_transaction_id=:proof_transaction_id::uuid AND outcome=:outcome::text;
