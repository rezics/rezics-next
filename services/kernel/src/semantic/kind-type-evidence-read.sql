-- One exact native retained body; no scan, foreign home or caller projection.
-- Keep this row and BOTH anchor fences locked until final commit/rollback.
SELECT binding, body, progress, producer_transaction
FROM semantic.kind_type_evidence_body
WHERE route = :route::integer AND owner_account_id = :owner_account_id::uuid
  AND collection_id = :collection_id::uuid AND preparation_id = :preparation_id::uuid
  AND evidence_id = :evidence_id::uuid
FOR UPDATE;
