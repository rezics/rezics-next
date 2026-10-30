SELECT 1 AS present
FROM access.auth_history_proof
WHERE route=:route AND account_id=:account_id::uuid AND phase=:phase
  AND version=:version::integer AND at=:at::timestamptz
  AND continuation_id IS NOT DISTINCT FROM :continuation_id::nullable(uuid)
  AND receipt_id IS NOT DISTINCT FROM :receipt_id::nullable(uuid);
