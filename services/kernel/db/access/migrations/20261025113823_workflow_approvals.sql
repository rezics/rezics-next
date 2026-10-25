-- migrate:up
CREATE TABLE access.workflow_approval (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  approval_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 1024),
  scopes text[] NOT NULL CHECK (cardinality(scopes) <= 6450 AND octet_length(array_to_string(scopes, ' ')) <= 12900),
  requested_by text CHECK (length(requested_by) <= 100),
  authn_epoch bigint NOT NULL CHECK (authn_epoch > 0 AND authn_epoch <= 9007199254740991),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 255),
  operation jsonb NOT NULL CHECK (jsonb_typeof(operation) = 'object' AND octet_length(operation::text) <= 16384),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  jwt_expires_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, approval_id),
  CHECK (route = get_byte(uuid_send(approval_id), 10) * 256 + get_byte(uuid_send(approval_id), 11)),
  CHECK (route = get_byte(uuid_send(actor_id), 10) * 256 + get_byte(uuid_send(actor_id), 11)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '300 seconds' AND expires_at <= jwt_expires_at)
);
CREATE INDEX workflow_approval_expiry ON access.workflow_approval (route, expires_at, approval_id);
CREATE FUNCTION access.workflow_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Workflow approvals are immutable';
END;
$$;
CREATE TRIGGER workflow_approval_immutable BEFORE UPDATE ON access.workflow_approval
FOR EACH ROW EXECUTE FUNCTION access.workflow_approval_immutable();

-- migrate:down
DROP TABLE access.workflow_approval;
DROP FUNCTION access.workflow_approval_immutable();
