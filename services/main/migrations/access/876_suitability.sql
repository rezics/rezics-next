CREATE TABLE access.suitability_assessment (
  id uuid PRIMARY KEY,
  target text NOT NULL CHECK (target ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  labels text[] NOT NULL CHECK (labels IN ('{}'::text[], '{r15}'::text[],
    '{r18}'::text[], '{r18g}'::text[], '{r18,r18g}'::text[])),
  basis text NOT NULL CHECK (basis IN ('author', 'platform', 'source')),
  source_id text CHECK (length(source_id) BETWEEN 1 AND 512),
  assessor text NOT NULL REFERENCES access.authority_subject(id),
  principal_id uuid NOT NULL REFERENCES access.principal(id),
  predecessor uuid,
  predecessor_number bigint,
  revision_number bigint NOT NULL CHECK (revision_number > 0),
  authority_proof jsonb NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((basis = 'source') = (source_id IS NOT NULL)),
  CHECK ((predecessor IS NULL AND predecessor_number IS NULL AND revision_number = 1)
    OR (predecessor IS NOT NULL AND predecessor <> id AND predecessor_number IS NOT NULL
      AND revision_number = predecessor_number + 1)),
  UNIQUE (target, id, revision_number),
  FOREIGN KEY (target, predecessor, predecessor_number)
    REFERENCES access.suitability_assessment(target, id, revision_number),
  -- NULLS NOT DISTINCT enforces one root; each revision has at most one successor.
  -- https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS
  CONSTRAINT suitability_current_head UNIQUE NULLS NOT DISTINCT (target, predecessor),
  UNIQUE (target, revision_number),
  UNIQUE (principal_id, idempotency_key)
);

CREATE INDEX suitability_platform_floor ON access.suitability_assessment (target, revision_number DESC)
  WHERE basis = 'platform';

CREATE FUNCTION access.reject_suitability_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Suitability assessments are append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER suitability_assessment_immutable BEFORE UPDATE OR DELETE
  ON access.suitability_assessment FOR EACH ROW
  EXECUTE FUNCTION access.reject_suitability_mutation();
