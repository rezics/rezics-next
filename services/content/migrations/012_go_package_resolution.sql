CREATE SCHEMA IF NOT EXISTS pkg;

CREATE FUNCTION pkg.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable package evidence cannot be updated or deleted';
END;
$$;

CREATE TABLE pkg.go_resolution (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX go_resolution_principal_idx ON pkg.go_resolution (principal_id, id);
CREATE TRIGGER pkg_go_resolution_immutable BEFORE UPDATE OR DELETE ON pkg.go_resolution
  FOR EACH ROW EXECUTE FUNCTION pkg.no_mutation();
