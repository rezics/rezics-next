-- Skill packages and Prompts are Work content. Their exact revisions are the
-- existing content.revision rows (draft.save receipt, outbox and publication
-- pins unchanged); Hub rows only type those revisions, pin file bytes and
-- expose declared requirements. The graph owns the Work identity and kind.
CREATE SCHEMA IF NOT EXISTS hub;

CREATE FUNCTION hub.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable Hub record' USING ERRCODE = '23514';
END $$;

CREATE TABLE hub.variant_profile (
  variant_id text PRIMARY KEY REFERENCES content.variant(id),
  kind text NOT NULL CHECK (kind IN ('skill-package', 'prompt')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (variant_id, kind)
);
CREATE TRIGGER hub_variant_profile_immutable BEFORE UPDATE OR DELETE ON hub.variant_profile
  FOR EACH ROW EXECUTE FUNCTION hub.no_mutation();

CREATE TABLE hub.revision (
  revision_id uuid PRIMARY KEY,
  variant_id text NOT NULL,
  kind text NOT NULL,
  body_model text NOT NULL,
  applicability jsonb NOT NULL
    CHECK (jsonb_typeof(applicability) = 'object' AND octet_length(applicability::text) <= 16384),
  parameter_schema_sha256 text CHECK (parameter_schema_sha256 ~ '^[0-9a-f]{64}$'),
  parameter_schema_dialect text
    CHECK (parameter_schema_dialect = 'https://json-schema.org/draft/2020-12/schema'),
  file_count integer NOT NULL CHECK (file_count BETWEEN 0 AND 1024),
  requirement_count integer NOT NULL CHECK (requirement_count BETWEEN 0 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (revision_id, kind),
  FOREIGN KEY (variant_id, revision_id) REFERENCES content.revision(variant_id, id),
  FOREIGN KEY (variant_id, kind) REFERENCES hub.variant_profile(variant_id, kind),
  CHECK ((kind = 'skill-package' AND body_model ~ '^rezics-skill-package-v[1-9][0-9]{0,2}$'
      AND file_count >= 1 AND parameter_schema_sha256 IS NULL AND parameter_schema_dialect IS NULL)
    OR (kind = 'prompt' AND body_model ~ '^rezics-prompt-v[1-9][0-9]{0,2}$'
      AND file_count = 0 AND requirement_count = 0
      AND parameter_schema_sha256 IS NOT NULL AND parameter_schema_dialect IS NOT NULL))
);
CREATE INDEX hub_revision_variant_idx ON hub.revision (variant_id, created_at DESC, revision_id);
CREATE TRIGGER hub_revision_immutable BEFORE UPDATE OR DELETE ON hub.revision
  FOR EACH ROW EXECUTE FUNCTION hub.no_mutation();

CREATE FUNCTION hub.check_revision_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM content.revision
    WHERE id = NEW.revision_id AND variant_id = NEW.variant_id AND model = NEW.body_model;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub revision model differs from its Content revision' USING ERRCODE = '23514',
      CONSTRAINT = 'hub_revision_model';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_revision_model BEFORE INSERT ON hub.revision
  FOR EACH ROW EXECUTE FUNCTION hub.check_revision_model();
CREATE TRIGGER hub_revision_open AFTER INSERT ON hub.revision
  FOR EACH ROW EXECUTE FUNCTION pkg.open_aggregate('hub_revision', 'revision_id');

-- Directory and file identities. Bytes are verified artifacts; an observed
-- executable bit is data and never grants execution.
CREATE TABLE hub.revision_file (
  revision_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'skill-package' CHECK (kind = 'skill-package'),
  path text NOT NULL CHECK (pkg.confined_path(path)),
  file_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('manifest', 'script', 'reference', 'asset', 'other')),
  artifact_id uuid NOT NULL,
  sha256 text NOT NULL,
  mode_executable boolean NOT NULL,
  PRIMARY KEY (revision_id, path),
  UNIQUE (revision_id, file_id),
  FOREIGN KEY (revision_id, kind) REFERENCES hub.revision(revision_id, kind),
  FOREIGN KEY (artifact_id, sha256) REFERENCES pkg.artifact(id, sha256),
  CHECK ((role = 'manifest') = (path = 'SKILL.md'))
);
CREATE INDEX hub_revision_file_artifact_idx ON hub.revision_file (artifact_id);
CREATE TRIGGER hub_revision_file_immutable BEFORE UPDATE OR DELETE ON hub.revision_file
  FOR EACH ROW EXECUTE FUNCTION hub.no_mutation();

CREATE FUNCTION hub.check_file_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM pkg.artifact WHERE id = NEW.artifact_id AND state = 'verified' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hub file bytes are not a verified artifact' USING ERRCODE = '23514',
      CONSTRAINT = 'hub_file_artifact_verified';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_revision_file_artifact BEFORE INSERT ON hub.revision_file
  FOR EACH ROW EXECUTE FUNCTION hub.check_file_artifact();
CREATE TRIGGER hub_revision_file_open BEFORE INSERT ON hub.revision_file
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('hub_revision', 'revision_id');

-- Declared and missing requirements keep native syntax and their manifest
-- location. The ecosystem column joins lock segments by composite key, so an
-- npm requirement can only be satisfied by an npm segment.
CREATE TABLE hub.revision_requirement (
  revision_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
  kind text NOT NULL DEFAULT 'skill-package' CHECK (kind = 'skill-package'),
  ecosystem text NOT NULL CHECK (ecosystem ~ '^[a-z][a-z0-9-]{0,31}$'),
  native_selector text NOT NULL CHECK (octet_length(native_selector) BETWEEN 1 AND 1024),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object' AND octet_length(target::text) <= 4096),
  strength text NOT NULL CHECK (strength IN ('required', 'optional')),
  declaration text NOT NULL CHECK (declaration IN ('declared', 'missing', 'unsupported')),
  source_path text NOT NULL,
  source_pointer text NOT NULL CHECK (octet_length(source_pointer) <= 512),
  PRIMARY KEY (revision_id, ordinal),
  UNIQUE (revision_id, ordinal, ecosystem),
  FOREIGN KEY (revision_id, kind) REFERENCES hub.revision(revision_id, kind),
  FOREIGN KEY (revision_id, source_path) REFERENCES hub.revision_file(revision_id, path)
);
CREATE TRIGGER hub_revision_requirement_immutable BEFORE UPDATE OR DELETE ON hub.revision_requirement
  FOR EACH ROW EXECUTE FUNCTION hub.no_mutation();
CREATE TRIGGER hub_revision_requirement_open BEFORE INSERT ON hub.revision_requirement
  FOR EACH ROW EXECUTE FUNCTION pkg.require_open_aggregate('hub_revision', 'revision_id');

-- Commit-time completeness: declared counts match, and a Skill has one
-- root SKILL.md manifest.
CREATE FUNCTION hub.check_revision_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE files integer; manifests integer; requirements integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE role = 'manifest') INTO files, manifests
    FROM hub.revision_file WHERE revision_id = NEW.revision_id;
  SELECT count(*) INTO requirements FROM hub.revision_requirement WHERE revision_id = NEW.revision_id;
  IF files <> NEW.file_count OR requirements <> NEW.requirement_count
    OR (NEW.kind = 'skill-package' AND manifests <> 1) THEN
    RAISE EXCEPTION 'Hub revision inventory is incomplete' USING ERRCODE = '23514',
      CONSTRAINT = 'hub_revision_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER hub_revision_complete AFTER INSERT ON hub.revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hub.check_revision_complete();

-- One idempotent import receipt per principal key. Ingestion is inert: it
-- parses retained bytes only, with no execution, secret or network authority.
-- A successful import names the Content draft.save operation it produced.
CREATE TABLE hub.import (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  source_format text NOT NULL
    CHECK (source_format IN ('agent-skills-directory-v1', 'repository-package-v1')),
  source_tree_sha256 text NOT NULL CHECK (source_tree_sha256 ~ '^[0-9a-f]{64}$'),
  source_locator jsonb NOT NULL
    CHECK (jsonb_typeof(source_locator) = 'object' AND octet_length(source_locator::text) <= 4096),
  ingest_profile text NOT NULL CHECK (ingest_profile = 'inert-ingest-v1'),
  outcome text NOT NULL CHECK (outcome IN ('imported', 'rejected')),
  content_operation_id text UNIQUE REFERENCES content.receipt(operation_id),
  revision_id uuid UNIQUE REFERENCES hub.revision(revision_id),
  rejection jsonb CHECK (jsonb_typeof(rejection) = 'object' AND octet_length(rejection::text) <= 16384),
  residuals jsonb NOT NULL
    CHECK (jsonb_typeof(residuals) = 'array' AND octet_length(residuals::text) <= 65536),
  unsupported jsonb NOT NULL
    CHECK (jsonb_typeof(unsupported) = 'array' AND octet_length(unsupported::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  CHECK ((outcome = 'imported' AND content_operation_id IS NOT NULL AND revision_id IS NOT NULL
      AND rejection IS NULL)
    OR (outcome = 'rejected' AND content_operation_id IS NULL AND revision_id IS NULL
      AND rejection IS NOT NULL))
);
CREATE INDEX hub_import_principal_idx ON hub.import (principal_id, id);
CREATE TRIGGER hub_import_immutable BEFORE UPDATE OR DELETE ON hub.import
  FOR EACH ROW EXECUTE FUNCTION hub.no_mutation();

CREATE FUNCTION hub.check_import_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'imported' THEN
    PERFORM 1 FROM content.receipt
      WHERE operation_id = NEW.content_operation_id AND action = 'draft.save'
        AND outcome = 'succeeded' AND revision_id = NEW.revision_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Hub import does not name its Content revision receipt' USING ERRCODE = '23514',
        CONSTRAINT = 'hub_import_receipt';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hub_import_receipt BEFORE INSERT ON hub.import
  FOR EACH ROW EXECUTE FUNCTION hub.check_import_receipt();
