-- Exact immutable source; read its creation receipt in the same snapshot.
-- Keep timestamp text at PostgreSQL precision for the source commitment.
SELECT o.route, o.operation_id, o.native_workflow_id, o.initiator_account_id, o.author_account_id,
       o.thread_id, o.actor_kind, o.actor_account_id, o.actor_client_id,
       o.actor_scopes, o.actor_requested_by, o.actor_authn_epoch,
       o.empty_scope, o.upper_created_at::text AS upper_created_at, o.upper_post_id,
       o.recorded_transaction_id, o.source_digest,
       o.original_minimum_authn_epoch, o.original_operator_account_id,
       o.original_delegation_transaction_id, o.original_delegation_issued_valid,
       o.creation_command_kind, o.creation_idempotency_key, o.creation_request_digest,
       o.creation_target_route, o.creation_target_id
FROM content.operation o
WHERE o.route = :route::integer AND o.operation_id = :operation_id::uuid;
