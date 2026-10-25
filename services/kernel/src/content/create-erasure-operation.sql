WITH initiator AS (SELECT :initiator_id::uuid AS id)
INSERT INTO content.operation (
  route, operation_id, initiator_account_id, author_account_id, thread_id,
  actor_kind, actor_account_id, actor_client_id, actor_scopes, actor_requested_by,
  actor_authn_epoch, empty_scope, upper_created_at, upper_post_id, requested_at,
  recorded_transaction_id
) SELECT
  :route::integer, :operation_id::uuid, (SELECT id FROM initiator), :author_id::uuid, :thread_id::uuid,
  'account', (SELECT id FROM initiator), :client_id::text, :scopes::text[], :requested_by::nullable(text),
  :authn_epoch::bigint, false, :upper_created_at::timestamptz, :upper_post_id::uuid, :at::timestamptz,
  :transaction_id::uuid;
