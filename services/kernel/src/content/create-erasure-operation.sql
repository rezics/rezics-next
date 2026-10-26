WITH initiator AS (SELECT :initiator_id::uuid AS id)
INSERT INTO content.operation (
  route, operation_id, initiator_account_id, author_account_id, thread_id, anchor_post_id,
  actor_kind, actor_account_id, actor_client_id, actor_scopes, actor_requested_by,
  actor_authn_epoch, empty_scope, upper_created_at, upper_post_id, requested_at,
  recorded_transaction_id, source_digest, original_minimum_authn_epoch,
  original_operator_account_id, original_delegation_transaction_id,
  original_delegation_issued_valid, creation_command_kind, creation_idempotency_key,
  creation_request_digest, creation_target_route, creation_target_id
) SELECT
  :route::integer, :operation_id::uuid, (SELECT id FROM initiator), :author_id::uuid, :thread_id::uuid,
  :anchor_post_id::uuid,
  'account', (SELECT id FROM initiator), :client_id::text, :scopes::text[], :requested_by::nullable(text),
  :authn_epoch::bigint, false, :upper_created_at::timestamptz, :upper_post_id::uuid, :at::timestamptz,
  :transaction_id::uuid, :source_digest::text, :original_minimum_authn_epoch::text,
  :original_operator_account_id::nullable(uuid), :original_delegation_transaction_id::nullable(uuid),
  :original_delegation_issued_valid::nullable(text), :creation_command_kind::text, :creation_idempotency_key::text,
  :creation_request_digest::text, :creation_target_route::integer, :creation_target_id::uuid;
