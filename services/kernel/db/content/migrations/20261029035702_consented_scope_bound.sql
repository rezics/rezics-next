-- migrate:up
CREATE OR REPLACE FUNCTION content.operation_scopes_valid(scopes text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (cardinality(scopes) = 0 OR array_ndims(scopes) = 1)
    AND cardinality(scopes) <= 512
    AND octet_length(array_to_string(scopes, ' ')) <= 66047
    AND COALESCE(bool_and(scope IS NOT NULL AND scope ~ '^[!-~]{1,128}$'
      AND position('"' in scope) = 0 AND position(chr(92) in scope) = 0), true)
  FROM unnest(scopes) AS scope
$$;

ALTER TABLE content.operation
  DROP CONSTRAINT operation_initiator_wire,
  ADD CONSTRAINT operation_initiator_wire CHECK (source_digest IS NULL OR (
    content.operation_routable_uuid(operation_id)
    AND content.operation_routable_uuid(initiator_account_id)
    AND content.operation_routable_uuid(recorded_transaction_id)
    AND content.operation_routable_uuid(thread_id)
    AND content.operation_routable_uuid(author_account_id)
    AND content.operation_routable_uuid(upper_post_id)
    AND actor_client_id ~ '^[!-~]+$'
    AND cardinality(actor_scopes) <= 512
    AND (actor_requested_by IS NULL OR (
      char_length(actor_requested_by) <= 128
      AND actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))));

-- migrate:down
-- Forward only: retained snapshots may exceed the previous bound.
