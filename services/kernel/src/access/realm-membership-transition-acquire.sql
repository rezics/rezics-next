-- The native account row is locked before this statement. Stable legacy holds
-- require reconciliation; they cannot be silently converted to fresh authority.
WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :account_id::uuid AS account_id, :realm_id::uuid AS realm_id,
 :reservation_id::uuid AS reservation_id, :generation_id::uuid AS generation_id,
 :operation_id::text AS operation_id, :transaction_id::uuid AS transaction_id
), added AS (
 INSERT INTO access.realm_membership_transition
 (route,account_id,realm_id,reservation_id,generation_id,operation_id,hold_transaction_id)
 SELECT i.route,i.account_id,i.realm_id,i.reservation_id,i.generation_id,i.operation_id,i.transaction_id FROM input i
 WHERE NOT EXISTS (SELECT 1 FROM access.lifecycle_coordination h
   WHERE h.route=i.route AND h.account_id=i.account_id AND h.reservation_id=i.reservation_id)
 AND NOT EXISTS (SELECT 1 FROM access.realm_membership_transition t
   WHERE t.route=i.route AND t.account_id=i.account_id AND t.realm_id=i.realm_id AND t.proof_transaction_id IS NULL)
 RETURNING *
), held AS (
 INSERT INTO access.lifecycle_coordination
 (route,account_id,reservation_id,related_account_id,purpose,transaction_id)
 SELECT route,account_id,generation_id,realm_id,'membership',hold_transaction_id FROM added
 RETURNING reservation_id
)
SELECT reservation_id::text AS "generationId" FROM held;
