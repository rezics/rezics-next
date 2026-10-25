-- migrate:up
ALTER TABLE semantic.revision ADD COLUMN source jsonb;
ALTER TABLE semantic.revision DROP CONSTRAINT revision_kind_check;
ALTER TABLE semantic.revision ADD CONSTRAINT revision_kind_check
  CHECK (kind IN ('create', 'propose', 'accept', 'reject', 'adopt', 'merge', 'retract'));

CREATE TABLE semantic.external_claim (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  source text NOT NULL,
  external_id text NOT NULL,
  subject_id uuid NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, source, external_id),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id)
);
CREATE TRIGGER external_claim_immutable BEFORE UPDATE OR DELETE ON semantic.external_claim
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER external_claim_immutable_truncate BEFORE TRUNCATE ON semantic.external_claim
FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE TABLE semantic.retraction (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  revision integer NOT NULL,
  "references" jsonb NOT NULL CHECK (jsonb_typeof("references") = 'array'),
  PRIMARY KEY (route, subject_id, candidate_id, revision),
  FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate (route, subject_id, candidate_id),
  FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision (route, subject_id, revision)
);
CREATE TRIGGER retraction_immutable BEFORE UPDATE OR DELETE ON semantic.retraction
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER retraction_immutable_truncate BEFORE TRUNCATE ON semantic.retraction
FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE TABLE semantic.source_candidate (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  source text NOT NULL,
  external_id text NOT NULL,
  field_group text NOT NULL,
  statement_digest text NOT NULL CHECK (statement_digest ~ '^[0-9a-f]{64}$'),
  candidate_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, source, external_id, field_group, statement_digest),
  FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate (route, subject_id, candidate_id)
);

CREATE INDEX source_candidate_retract ON semantic.source_candidate (route, subject_id, candidate_id, source, external_id, field_group);

-- migrate:down
DROP TABLE semantic.source_candidate;
DROP TABLE semantic.retraction;
DROP TABLE semantic.external_claim;
ALTER TABLE semantic.revision DROP COLUMN source;
ALTER TABLE semantic.revision DROP CONSTRAINT revision_kind_check;
ALTER TABLE semantic.revision ADD CONSTRAINT revision_kind_check
  CHECK (kind IN ('create', 'propose', 'accept', 'reject', 'adopt', 'merge'));
