-- Exact immutable source by its primary key. Keep timestamps out of the commitment.
SELECT o.route, o.operation_id::text AS operation_id, o.kind, o.realm_id::text AS realm_id,
       o.space_id::text AS space_id, o.member_account_id::text AS member_account_id,
       o.reservation_id::text AS reservation_id, o.ban_id::text AS ban_id,
       o.initiator_account_id::text AS initiator_account_id, o.actor_client_id, o.actor_scopes,
       o.actor_requested_by, o.actor_authn_epoch, o.recorded_transaction_id::text AS recorded_transaction_id,
       o.source_digest, o.original_minimum_authn_epoch,
       o.original_operator_account_id::text AS original_operator_account_id,
       o.original_delegation_transaction_id::text AS original_delegation_transaction_id,
       o.original_delegation_issued_valid, o.creation_command_kind, o.creation_idempotency_key,
       o.creation_request_digest, o.creation_target_route, o.creation_target_id::text AS creation_target_id
FROM community.realm_membership_operation o
WHERE o.route = :route::integer AND o.operation_id = :operation_id::uuid;
