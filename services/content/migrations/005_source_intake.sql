CREATE SCHEMA IF NOT EXISTS source;

CREATE TABLE source.record (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 100),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, namespace, external_id)
);

CREATE TABLE source.observation (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES source.record(id),
  principal_id uuid NOT NULL,
  source_revision text CHECK (source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 200),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 100),
  retention text NOT NULL CHECK (retention IN ('retained', 'not-retained')),
  raw_bytes bytea,
  byte_digest text CHECK (byte_digest IS NULL OR byte_digest ~ '^[0-9a-f]{64}$'),
  coverage jsonb NOT NULL CHECK (jsonb_typeof(coverage) = 'object'),
  rights_evidence jsonb NOT NULL CHECK (jsonb_typeof(rights_evidence) = 'object'),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((retention = 'retained' AND raw_bytes IS NOT NULL AND byte_digest IS NOT NULL
      AND octet_length(raw_bytes) <= 65536)
    OR (retention = 'not-retained' AND raw_bytes IS NULL AND byte_digest IS NULL))
);
CREATE INDEX observation_record_idx ON source.observation (record_id, submitted_at, id);
CREATE INDEX observation_principal_idx ON source.observation (principal_id, id);

CREATE TABLE source.intake_receipt (
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_id, idempotency_key),
  UNIQUE (observation_id)
);

CREATE FUNCTION source.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable source evidence' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER source_record_immutable BEFORE UPDATE OR DELETE ON source.record
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
CREATE TRIGGER source_observation_immutable BEFORE UPDATE OR DELETE ON source.observation
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
CREATE TRIGGER source_receipt_immutable BEFORE UPDATE OR DELETE ON source.intake_receipt
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
