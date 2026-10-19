-- Opt-in custody supplements original intake receipts; it does not widen the
-- observation byte ceiling or replace any original observation identity.
CREATE TABLE source.archive_admission (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  record_id uuid NOT NULL REFERENCES source.record(id),
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  observation_digest text NOT NULL CHECK (observation_digest ~ '^[0-9a-f]{64}$'),
  archive_digest text NOT NULL CHECK (archive_digest ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 1 AND 1073741824),
  media_type text NOT NULL CHECK (media_type IN ('application/x-tar','application/zstd')),
  parts jsonb NOT NULL CHECK (jsonb_typeof(parts) = 'array' AND jsonb_array_length(parts) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX source_archive_observation ON source.archive_admission(observation_id, principal_id);
CREATE TRIGGER source_archive_admission_immutable BEFORE UPDATE OR DELETE ON source.archive_admission
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
