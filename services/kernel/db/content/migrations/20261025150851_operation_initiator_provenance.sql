-- migrate:up
-- The operation is its own immutable source. Accounts owns capture and restore;
-- Content stores only the allowlisted creation snapshot, never credentials.
-- NULL provenance on pre-existing rows is intentionally not reconstructed.
CREATE FUNCTION content.operation_routable_uuid(id uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$$;

ALTER TABLE content.operation
  ADD COLUMN source_digest text CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN original_minimum_authn_epoch text
    CHECK (original_minimum_authn_epoch ~ '^[1-9][0-9]{0,18}$'),
  ADD COLUMN original_operator_account_id uuid
    CHECK (content.operation_routable_uuid(original_operator_account_id)),
  ADD COLUMN original_delegation_transaction_id uuid
    CHECK (content.operation_routable_uuid(original_delegation_transaction_id)),
  ADD COLUMN original_delegation_issued_valid text
    CHECK (char_length(original_delegation_issued_valid) BETWEEN 1 AND 256),
  ADD COLUMN creation_command_kind text CHECK (creation_command_kind = 'content.author-erasure'),
  ADD COLUMN creation_idempotency_key text CHECK (creation_idempotency_key ~ '^[!-~]{1,255}$'),
  ADD COLUMN creation_request_digest text CHECK (creation_request_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN creation_target_route integer CHECK (creation_target_route BETWEEN 0 AND 65535),
  ADD COLUMN creation_target_id uuid CHECK (content.operation_routable_uuid(creation_target_id)),
  ADD CONSTRAINT operation_creation_target_route CHECK (
    creation_target_route = get_byte(uuid_send(creation_target_id), 10) * 256
      + get_byte(uuid_send(creation_target_id), 11)),
  ADD CONSTRAINT operation_initiator_wire CHECK (source_digest IS NULL OR (
    content.operation_routable_uuid(operation_id)
    AND content.operation_routable_uuid(initiator_account_id)
    AND content.operation_routable_uuid(recorded_transaction_id)
    AND content.operation_routable_uuid(thread_id)
    AND content.operation_routable_uuid(author_account_id)
    AND content.operation_routable_uuid(upper_post_id)
    AND actor_client_id ~ '^[!-~]+$'
    AND cardinality(actor_scopes) <= 100
    AND (actor_requested_by IS NULL OR (
      char_length(actor_requested_by) <= 128
      AND actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))));

-- guard_operation_identity compares every non-workflow column, including these
-- new fields. Only creation can commit them; no backfill or later repair grants
-- authority. A reader requires every non-nullable record field, both delegation
-- fields when requestedBy is present, and the exact matching creation receipt.
-- operator NULL and delegation NULL without requestedBy are real snapshots.
-- migrate:down
-- Forward only: preserve immutable initiator provenance and receipt bindings.
