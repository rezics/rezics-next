WITH input AS (SELECT :at::timestamptz AS at)
UPDATE access.workflow_approval
SET consumed_at = i.at, consumed_transaction_id = :transaction_id
FROM input i
WHERE route = :route AND approval_id = :approval_id AND digest = :digest
  AND operation->>'kind' = 'credential' AND consumed_at IS NULL
  AND i.at < expires_at
  AND i.at < jwt_expires_at
RETURNING approval_id;
