SELECT request_digest AS "requestDigest", epoch, position, transaction_id AS "transactionId", response,
       payload_state AS "payloadState"
FROM core.receipt
WHERE partition_no = :partition_no AND principal_kind = :principal_kind AND principal_id = :principal_id
  AND command_kind = :command_kind AND idempotency_key = ANY(:idempotency_keys::text[])
LIMIT 1;
