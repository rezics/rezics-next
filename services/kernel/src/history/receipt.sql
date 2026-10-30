UPDATE core.receipt SET response='null'::jsonb, payload_state='minimized'
WHERE partition_no=:partition_no AND principal_kind=:principal_kind AND principal_id=:principal_id
  AND command_kind=:command_kind AND idempotency_key=:storage_key
  AND payload_state='present'
RETURNING transaction_id;
