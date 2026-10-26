-- migrate:up

-- The committed identity of one accepted Realm join, leave or ban removal. The
-- membership workflow restores its initiator from this row at every step, so the
-- row is its own immutable source: the acceptance command writes it once, with the
-- original authenticated actor fields, and nothing edits it afterwards. It lives on
-- the Realm route. Accounts and Realms are external anchors and have no foreign keys.
CREATE TABLE community.realm_membership_operation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('join', 'leave', 'removal')),
  realm_id uuid NOT NULL,
  space_id uuid NOT NULL,
  member_account_id uuid NOT NULL,
  reservation_id uuid,
  ban_id uuid,
  initiator_account_id uuid NOT NULL,
  actor_client_id text NOT NULL CHECK (char_length(actor_client_id) BETWEEN 1 AND 1024),
  actor_scopes text[] NOT NULL CHECK (cardinality(actor_scopes) <= 100 AND (cardinality(actor_scopes) = 0 OR array_ndims(actor_scopes) = 1)),
  actor_requested_by text CHECK (actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  actor_authn_epoch bigint NOT NULL CHECK (actor_authn_epoch BETWEEN 1 AND 9007199254740991),
  requested_at timestamptz NOT NULL CHECK (isfinite(requested_at)),
  recorded_transaction_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  original_minimum_authn_epoch text NOT NULL CHECK (original_minimum_authn_epoch ~ '^[1-9][0-9]{0,18}$'),
  original_operator_account_id uuid,
  original_delegation_transaction_id uuid,
  original_delegation_issued_valid text CHECK (char_length(original_delegation_issued_valid) <= 256),
  creation_command_kind text NOT NULL CHECK (creation_command_kind ~ '^[!-~]{1,255}$'),
  creation_idempotency_key text NOT NULL CHECK (creation_idempotency_key ~ '^[!-~]{1,255}$'),
  creation_request_digest text NOT NULL CHECK (creation_request_digest ~ '^[0-9a-f]{64}$'),
  creation_target_route integer NOT NULL CHECK (creation_target_route BETWEEN 0 AND 65535),
  creation_target_id uuid NOT NULL,
  PRIMARY KEY (route, operation_id),
  CHECK (route = get_byte(uuid_send(operation_id), 10) * 256 + get_byte(uuid_send(operation_id), 11)),
  CHECK (route = get_byte(uuid_send(realm_id), 10) * 256 + get_byte(uuid_send(realm_id), 11)),
  CHECK ((kind = 'join' AND reservation_id IS NULL AND ban_id IS NULL)
    OR (kind = 'leave' AND reservation_id IS NOT NULL AND ban_id IS NULL AND member_account_id = initiator_account_id)
    OR (kind = 'removal' AND reservation_id IS NOT NULL AND ban_id IS NOT NULL)),
  CHECK ((actor_requested_by IS NULL) = (original_delegation_transaction_id IS NULL)),
  CHECK ((original_delegation_transaction_id IS NULL) = (original_delegation_issued_valid IS NULL))
);

CREATE FUNCTION community.guard_realm_membership_operation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Realm membership operations are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER realm_membership_operation_immutable BEFORE UPDATE OR DELETE ON community.realm_membership_operation
FOR EACH ROW EXECUTE FUNCTION community.guard_realm_membership_operation();

-- migrate:down
-- Forward only: a restored initiator must outlive the workflow that uses it.
