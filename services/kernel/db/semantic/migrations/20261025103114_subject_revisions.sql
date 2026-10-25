-- migrate:up
ALTER TABLE semantic.subject DROP CONSTRAINT subject_type_check;
ALTER TABLE semantic.subject ADD CONSTRAINT subject_type_check
  CHECK (type ~ '^[a-z][a-z0-9_]*:[A-Za-z][A-Za-z0-9_]*$');

CREATE TABLE semantic.revision (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  kind text NOT NULL CHECK (kind IN ('create', 'propose', 'accept', 'reject', 'adopt', 'merge')),
  release text NOT NULL CHECK (release ~ '^sha256:[0-9a-f]{64}$'),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, revision),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id)
);

CREATE INDEX revision_transaction ON semantic.revision (route, subject_id, recorded_transaction_id);

CREATE FUNCTION semantic.prevent_revision_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'Semantic revisions are immutable' USING ERRCODE = '23514'; END; $$;

CREATE TRIGGER revision_immutable
BEFORE UPDATE OR DELETE ON semantic.revision
FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();

CREATE TRIGGER revision_immutable_truncate
BEFORE TRUNCATE ON semantic.revision
FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();

-- migrate:down
DROP TABLE semantic.revision;
DROP FUNCTION semantic.prevent_revision_mutation();
ALTER TABLE semantic.subject DROP CONSTRAINT subject_type_check;
ALTER TABLE semantic.subject ADD CONSTRAINT subject_type_check CHECK (type = 'schema:Book');
