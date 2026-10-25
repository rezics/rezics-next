INSERT INTO access.committed_continuation (
  route, continuation_id, account_id, operation_key, operation_digest, command_key_prefix,
  barrier_receipt_id, barrier_transaction_id, minimum_authn_epoch, prior_handle,
  prior_operator_account_id, prior_reservation_id, allowlist, digest, created_at,
  committed_expires_at, expires_at
) VALUES (
  :route, :continuation_id, :account_id, :operation_key, :operation_digest, :command_key_prefix,
  :barrier_receipt_id, :barrier_transaction_id, :minimum_authn_epoch::bigint, NULLIF(:prior_handle::text, ''),
  NULLIF(:prior_operator_account_id::text, '')::uuid, NULLIF(:prior_reservation_id::text, '')::uuid,
  :allowlist::jsonb, :digest, :created_at::timestamptz, :committed_expires_at::timestamptz, :expires_at::timestamptz
)
RETURNING continuation_id AS "continuationId";
