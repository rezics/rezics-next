SELECT request_digest AS "requestDigest", epoch, position, transaction_id AS "transactionId", response
FROM core.receipt
WHERE partition_no = :partition_no AND actor_account_id = :actor_account_id
  AND command_kind = :command_kind AND idempotency_key = :idempotency_key;
