SELECT r.transaction_id
FROM core.receipt r
WHERE r.partition_no = :partition_no::integer AND r.principal_kind = 'account'
  AND r.principal_id = :initiator_account_id::uuid AND r.command_kind = :creation_command_kind::nullable(text)
  AND r.idempotency_key = ANY(:creation_idempotency_keys::text[])
  AND r.transaction_id = :recorded_transaction_id::uuid
  AND encode(r.request_digest, 'hex') = :creation_request_digest::nullable(text)
  AND r.response->>'operationId' = :operation_id::uuid::text
  AND r.response->>'durableInitiator' ~ '^[0-9a-f]{64}$'
LIMIT 1;
