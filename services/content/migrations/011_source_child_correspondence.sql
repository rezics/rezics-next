CREATE TABLE source.child_correspondence (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  record_id uuid NOT NULL REFERENCES source.record(id),
  base_conversion_id uuid NOT NULL REFERENCES source.conversion(id),
  candidate_conversion_id uuid NOT NULL REFERENCES source.conversion(id),
  field text NOT NULL CHECK (field IN ('authors', 'subjects')),
  base_occurrence text NOT NULL
    CHECK (base_occurrence ~ '^urn:rezics:source-occurrence:[0-9a-f]{64}$'),
  candidate_occurrence text NOT NULL
    CHECK (candidate_occurrence ~ '^urn:rezics:source-occurrence:[0-9a-f]{64}$'),
  base_ordinal integer NOT NULL CHECK (base_ordinal BETWEEN 0 AND 255),
  candidate_ordinal integer NOT NULL CHECK (candidate_ordinal BETWEEN 0 AND 255),
  source_key text NOT NULL CHECK (length(source_key) <= 200),
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (base_conversion_id <> candidate_conversion_id),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (base_conversion_id, candidate_conversion_id, field, base_occurrence),
  UNIQUE (base_conversion_id, candidate_conversion_id, field, candidate_occurrence)
);
CREATE INDEX child_correspondence_principal_idx
  ON source.child_correspondence (principal_id, id);
CREATE TRIGGER source_child_correspondence_immutable
  BEFORE UPDATE OR DELETE ON source.child_correspondence
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
