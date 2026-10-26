INSERT INTO community.realm_membership_operation (
  route, operation_id, kind, realm_id, space_id, member_account_id, reservation_id, ban_id,
  initiator_account_id, actor_client_id, actor_scopes, actor_requested_by, actor_authn_epoch,
  requested_at, recorded_transaction_id, source_digest, original_minimum_authn_epoch,
  original_operator_account_id, original_delegation_transaction_id, original_delegation_issued_valid,
  creation_command_kind, creation_idempotency_key, creation_request_digest,
  creation_target_route, creation_target_id
) VALUES (
  :route::integer, :operation_id::uuid, :kind::text, :realm_id::uuid, :space_id::uuid, :member_account_id::uuid,
  :reservation_id::nullable(uuid), :ban_id::nullable(uuid),
  :initiator_id::uuid, :client_id::text, :scopes::text[], :requested_by::nullable(text), :authn_epoch::bigint,
  :at::timestamptz, :transaction_id::uuid, :source_digest::text, :original_minimum_authn_epoch::text,
  :original_operator_account_id::nullable(uuid), :original_delegation_transaction_id::nullable(uuid),
  :original_delegation_issued_valid::nullable(text),
  :creation_command_kind::text, :creation_idempotency_key::text, :creation_request_digest::text,
  :creation_target_route::integer, :creation_target_id::uuid
);
