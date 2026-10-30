-- Consumption locks the same account as tombstone. Replay never spends another generation.
WITH input AS NOT MATERIALIZED (SELECT :proof_transaction_id::uuid AS proof_transaction_id, :outcome::text AS outcome, :transaction_id::uuid AS transaction_id, :route::integer AS route, :account_id::uuid AS account_id, :realm_id::uuid AS realm_id, :reservation_id::uuid AS reservation_id, :generation_id::uuid AS generation_id, :operation_id::text AS operation_id), consumed AS (
 UPDATE access.realm_membership_transition t
 SET proof_transaction_id=(SELECT proof_transaction_id FROM input), outcome=(SELECT outcome FROM input),
     consumed_transaction_id=(SELECT transaction_id FROM input)
 WHERE t.route=(SELECT route FROM input) AND t.account_id=(SELECT account_id FROM input) AND t.realm_id=(SELECT realm_id FROM input)
 AND t.reservation_id=(SELECT reservation_id FROM input) AND t.generation_id=(SELECT generation_id FROM input)
 AND t.operation_id=(SELECT operation_id FROM input) AND t.proof_transaction_id IS NULL
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
WHERE route=(SELECT route FROM input) AND account_id=(SELECT account_id FROM input) AND realm_id=(SELECT realm_id FROM input)
 AND reservation_id=(SELECT reservation_id FROM input) AND generation_id=(SELECT generation_id FROM input) AND operation_id=(SELECT operation_id FROM input)
 AND proof_transaction_id=(SELECT proof_transaction_id FROM input) AND outcome=(SELECT outcome FROM input);
