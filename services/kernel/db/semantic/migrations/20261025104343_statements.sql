-- migrate:up
ALTER TABLE semantic.fact DROP CONSTRAINT fact_operation_check;
ALTER TABLE semantic.fact DROP CONSTRAINT fact_log_seq_check;
ALTER TABLE semantic.fact DROP CONSTRAINT fact_check;
ALTER TABLE semantic.fact ADD CONSTRAINT fact_operation_check CHECK (operation IN ('assert', 'retract', 'expand'));
ALTER TABLE semantic.fact ADD CONSTRAINT fact_log_seq_check CHECK (log_seq BETWEEN 1 AND 33 AND (log_seq <> 33 OR operation = 'expand'));
ALTER TABLE semantic.fact ADD CONSTRAINT fact_check CHECK (
  (operation = 'expand' AND kind = 'statement' AND language IS NULL AND property IS NOT NULL
    AND statement_id IS NULL AND body = '{}'::jsonb)
  OR (operation <> 'expand' AND (
    (kind IN ('label', 'description', 'alias') AND language IS NOT NULL AND property IS NULL AND statement_id IS NULL)
    OR (kind = 'statement' AND language IS NULL AND property IS NOT NULL AND statement_id IS NOT NULL)
  ))
);
ALTER TABLE semantic.fact ADD CONSTRAINT fact_subject_route_check CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11));
ALTER TABLE semantic.revision ADD CONSTRAINT revision_subject_route_check CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11));
CREATE INDEX fact_terms ON semantic.fact (route, subject_id, slot_id, log_seq) WHERE kind <> 'statement';

CREATE TABLE semantic.candidate (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  property text NOT NULL,
  rank text NOT NULL CHECK (rank IN ('normal', 'preferred')),
  statement jsonb NOT NULL CHECK (jsonb_typeof(statement) = 'object'),
  release text NOT NULL CHECK (release ~ '^sha256:[0-9a-f]{64}$'),
  revision integer NOT NULL,
  origin text NOT NULL CHECK (origin IN ('compact', 'proposal')),
  view_order integer NOT NULL DEFAULT 0 CHECK (view_order BETWEEN 0 AND 32),
  PRIMARY KEY (route, subject_id, candidate_id),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision (route, subject_id, revision),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (route = get_byte(uuid_send(candidate_id), 10) * 256 + get_byte(uuid_send(candidate_id), 11))
);
CREATE INDEX candidate_page ON semantic.candidate (route, subject_id, slot_id, revision, view_order, candidate_id);

CREATE TABLE semantic.acceptance (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  context_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  head integer NOT NULL CHECK (head >= 1),
  verdict text NOT NULL CHECK (verdict IN ('accept', 'reject', 'abstain')),
  revision integer NOT NULL,
  PRIMARY KEY (route, subject_id, context_id, candidate_id, head),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate (route, subject_id, candidate_id),
  FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision (route, subject_id, revision),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);
CREATE TABLE semantic.adoption (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  context_id uuid NOT NULL,
  head integer NOT NULL CHECK (head >= 1),
  mode text NOT NULL CHECK (mode IN ('inherit', 'replace', 'suppress')),
  selection jsonb NOT NULL CHECK (jsonb_typeof(selection) = 'array'),
  revision integer NOT NULL,
  PRIMARY KEY (route, subject_id, slot_id, context_id, head),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision (route, subject_id, revision),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (jsonb_array_length(selection) <= 32),
  CHECK (NOT jsonb_path_exists(selection, '$[*] ? (@.candidate.type() != "string" || (@.rank != "normal" && @.rank != "preferred"))')),
  CHECK (NOT jsonb_path_exists(selection, '$[*] ? (!(exists(@.candidate)) || !(exists(@.rank)))'))
);

CREATE TRIGGER fact_immutable BEFORE UPDATE OR DELETE ON semantic.fact
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER fact_immutable_truncate BEFORE TRUNCATE ON semantic.fact
FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER candidate_immutable BEFORE UPDATE OR DELETE ON semantic.candidate
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER candidate_immutable_truncate BEFORE TRUNCATE ON semantic.candidate
FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER acceptance_immutable BEFORE UPDATE OR DELETE ON semantic.acceptance
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER acceptance_immutable_truncate BEFORE TRUNCATE ON semantic.acceptance
FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER adoption_immutable BEFORE UPDATE OR DELETE ON semantic.adoption
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();
CREATE TRIGGER adoption_immutable_truncate BEFORE TRUNCATE ON semantic.adoption
FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- migrate:down
DROP TABLE semantic.adoption;
DROP TABLE semantic.acceptance;
DROP TABLE semantic.candidate;
DROP TRIGGER fact_immutable ON semantic.fact;
DROP TRIGGER fact_immutable_truncate ON semantic.fact;
DROP INDEX semantic.fact_terms;
ALTER TABLE semantic.revision DROP CONSTRAINT revision_subject_route_check;
ALTER TABLE semantic.fact DROP CONSTRAINT fact_subject_route_check;
ALTER TABLE semantic.fact DROP CONSTRAINT fact_operation_check;
ALTER TABLE semantic.fact DROP CONSTRAINT fact_log_seq_check;
ALTER TABLE semantic.fact DROP CONSTRAINT fact_check;
ALTER TABLE semantic.fact ADD CONSTRAINT fact_operation_check CHECK (operation IN ('assert', 'retract'));
ALTER TABLE semantic.fact ADD CONSTRAINT fact_log_seq_check CHECK (log_seq BETWEEN 1 AND 32);
ALTER TABLE semantic.fact ADD CONSTRAINT fact_check CHECK (
  (kind IN ('label', 'description', 'alias') AND language IS NOT NULL AND property IS NULL AND statement_id IS NULL)
  OR (kind = 'statement' AND language IS NULL AND property IS NOT NULL AND statement_id IS NOT NULL)
);
