SELECT request_digest AS "requestDigest"
FROM core.receipt
WHERE partition_no = :partition_no AND principal_kind = :principal_kind AND principal_id = :principal_id
  AND command_kind = :command_kind AND idempotency_key = :idempotency_key;
