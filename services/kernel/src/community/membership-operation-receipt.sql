SELECT r.transaction_id::text AS receipt_transaction_id,
       encode(r.request_digest, 'hex') AS receipt_request_digest,
       r.response ->> 'durableInitiator' AS receipt_commitment
FROM core.receipt r
WHERE r.partition_no = :partition_no::integer
  AND r.principal_kind = 'account' AND r.principal_id = :initiator_account_id::uuid
  AND r.command_kind = :creation_command_kind::text
  AND r.idempotency_key = ANY(:creation_idempotency_keys::text[])
LIMIT 1;
