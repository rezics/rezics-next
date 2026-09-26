-- One export owner. A manifest pins exact member revisions at each member's own
-- owner position (no fabricated global snapshot), maps each source grain to the
-- target profile, keeps every loss as an explicit residual and records the rights
-- basis evaluated for this export's own use scope. The combined license scope
-- derives only from those member bases; corporate status or named-graph placement
-- is not an input. A different use scope is a different manifest with its own bases.
CREATE SCHEMA IF NOT EXISTS export;

CREATE FUNCTION export.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable export record' USING ERRCODE = '23514';
END $$;

CREATE TABLE export.manifest (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  admission_id uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  target_profile text NOT NULL CHECK (target_profile ~ '^[a-z0-9][a-z0-9.-]{0,62}-v[1-9][0-9]{0,3}$'),
  use_scope text NOT NULL CHECK (use_scope IN ('full', 'excerpt', 'quotation', 'evaluation')),
  state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'sealed', 'rejected')),
  completeness text CHECK (completeness IN ('complete', 'partial')),
  license_scope text CHECK (license_scope IN ('determined', 'uncertain', 'blocked')),
  license_expression text CHECK (length(license_expression) BETWEEN 1 AND 500),
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count BETWEEN 0 AND 100000),
  residual_count integer NOT NULL DEFAULT 0 CHECK (residual_count BETWEEN 0 AND 100000),
  manifest_digest text CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  rejection_reason text CHECK (length(rejection_reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed_at timestamptz,
  UNIQUE (principal_id, idempotency_key),
  CHECK ((state = 'sealed') = (sealed_at IS NOT NULL)),
  CHECK (state <> 'sealed' OR (manifest_digest IS NOT NULL AND completeness IS NOT NULL
    AND license_scope IN ('determined', 'uncertain'))),
  CHECK ((license_scope IS NOT DISTINCT FROM 'determined') = (license_expression IS NOT NULL)),
  CHECK ((state = 'rejected') = (rejection_reason IS NOT NULL))
);
CREATE INDEX manifest_principal_idx ON export.manifest (principal_id, created_at DESC, id);

CREATE TABLE export.member (
  manifest_id uuid NOT NULL REFERENCES export.manifest(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100000),
  source_owner text NOT NULL CHECK (source_owner IN ('content', 'graph', 'source', 'object')),
  source_namespace text NOT NULL CHECK (length(source_namespace) BETWEEN 1 AND 300),
  source_grain text NOT NULL CHECK (source_grain IN ('work', 'main_version', 'external_release',
    'edition', 'carrier', 'artifact', 'contribution', 'occurrence', 'agent', 'claim', 'evidence',
    'assessment', 'method', 'policy', 'context', 'definition', 'structure_revision',
    'content_revision', 'source_observation', 'value')),
  exact_ref text NOT NULL CHECK (length(exact_ref) BETWEEN 1 AND 512),
  content_revision_id uuid REFERENCES content.revision(id),
  ref_digest text NOT NULL CHECK (ref_digest ~ '^[0-9a-f]{64}$'),
  owner_data_epoch text NOT NULL CHECK (owner_data_epoch <> ''),
  owner_sequence numeric NOT NULL CHECK (owner_sequence >= 0 AND owner_sequence = trunc(owner_sequence)),
  source_position text CHECK (length(source_position) BETWEEN 1 AND 512),
  target_grain text CHECK (length(target_grain) BETWEEN 1 AND 200),
  mapping text NOT NULL CHECK (mapping IN ('exact', 'narrower', 'broader', 'split', 'unmapped')),
  PRIMARY KEY (manifest_id, ordinal),
  CHECK ((source_owner = 'content') = (content_revision_id IS NOT NULL)),
  CHECK (content_revision_id IS NULL OR exact_ref = content_revision_id::text),
  CHECK ((mapping = 'unmapped') = (target_grain IS NULL))
);
CREATE INDEX member_content_revision_idx ON export.member (content_revision_id, manifest_id)
  WHERE content_revision_id IS NOT NULL;

CREATE TABLE export.residual (
  manifest_id uuid NOT NULL REFERENCES export.manifest(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100000),
  member_ordinal integer,
  kind text NOT NULL CHECK (kind IN ('unmapped_grain', 'unsupported_scope', 'precision_loss',
    'language_loss', 'unknown_value', 'qualified_claim', 'context_scope', 'private_dependency',
    'erased', 'unavailable', 'rights_excluded', 'missing_member')),
  path text CHECK (length(path) BETWEEN 1 AND 512),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  PRIMARY KEY (manifest_id, ordinal),
  FOREIGN KEY (manifest_id, member_ordinal) REFERENCES export.member(manifest_id, ordinal)
);
CREATE INDEX residual_member_idx ON export.residual (manifest_id, member_ordinal)
  WHERE member_ordinal IS NOT NULL;

CREATE TABLE export.rights_basis (
  manifest_id uuid NOT NULL REFERENCES export.manifest(id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 1000),
  basis_kind text NOT NULL CHECK (basis_kind IN ('license_offering', 'use_assessment',
    'public_domain', 'unprotected_fact', 'statutory_exception', 'native_contribution')),
  basis_ref text CHECK (length(basis_ref) BETWEEN 1 AND 512),
  license_expression text CHECK (length(license_expression) BETWEEN 1 AND 500),
  notice text CHECK (length(notice) BETWEEN 1 AND 4000),
  obligations text[] NOT NULL DEFAULT '{}' CHECK (cardinality(obligations) <= 6
    AND obligations <@ ARRAY['attribution', 'share_alike', 'non_commercial', 'no_derivatives',
      'notice_retention', 'access_restriction']::text[]),
  PRIMARY KEY (manifest_id, ordinal),
  CHECK (basis_kind NOT IN ('license_offering', 'use_assessment', 'statutory_exception',
    'native_contribution') OR basis_ref IS NOT NULL),
  CHECK (basis_kind <> 'license_offering' OR license_expression IS NOT NULL)
);

CREATE TABLE export.member_basis (
  manifest_id uuid NOT NULL,
  member_ordinal integer NOT NULL,
  basis_ordinal smallint NOT NULL,
  PRIMARY KEY (manifest_id, member_ordinal, basis_ordinal),
  FOREIGN KEY (manifest_id, member_ordinal) REFERENCES export.member(manifest_id, ordinal),
  FOREIGN KEY (manifest_id, basis_ordinal) REFERENCES export.rights_basis(manifest_id, ordinal)
);
CREATE INDEX member_basis_basis_idx ON export.member_basis (manifest_id, basis_ordinal, member_ordinal);

-- Parts are recorded only while their manifest is staged and are then immutable.
-- The share lock makes a concurrent seal wait and then recount committed parts.
CREATE FUNCTION export.staged_part() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM export.manifest WHERE id = NEW.manifest_id AND state = 'staged'
                 FOR SHARE) THEN
    RAISE EXCEPTION 'export parts require a staged manifest' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER member_staged BEFORE INSERT ON export.member
  FOR EACH ROW EXECUTE FUNCTION export.staged_part();
CREATE TRIGGER residual_staged BEFORE INSERT ON export.residual
  FOR EACH ROW EXECUTE FUNCTION export.staged_part();
CREATE TRIGGER rights_basis_staged BEFORE INSERT ON export.rights_basis
  FOR EACH ROW EXECUTE FUNCTION export.staged_part();
CREATE TRIGGER member_basis_staged BEFORE INSERT ON export.member_basis
  FOR EACH ROW EXECUTE FUNCTION export.staged_part();
CREATE TRIGGER member_immutable BEFORE UPDATE OR DELETE ON export.member
  FOR EACH ROW EXECUTE FUNCTION export.no_mutation();
CREATE TRIGGER residual_immutable BEFORE UPDATE OR DELETE ON export.residual
  FOR EACH ROW EXECUTE FUNCTION export.no_mutation();
CREATE TRIGGER rights_basis_immutable BEFORE UPDATE OR DELETE ON export.rights_basis
  FOR EACH ROW EXECUTE FUNCTION export.no_mutation();
CREATE TRIGGER member_basis_immutable BEFORE UPDATE OR DELETE ON export.member_basis
  FOR EACH ROW EXECUTE FUNCTION export.no_mutation();

-- A manifest leaves staged exactly once. Sealing proves its recorded counts and
-- that every mapped member carries at least one basis for this export.
CREATE FUNCTION export.manifest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'staged' THEN
    RAISE EXCEPTION 'export manifest is immutable after staging' USING ERRCODE = '23514';
  END IF;
  IF (OLD.id, OLD.principal_id, OLD.idempotency_key, OLD.request_digest, OLD.admission_id,
      OLD.authority_epoch, OLD.target_profile, OLD.use_scope, OLD.created_at)
     IS DISTINCT FROM
     (NEW.id, NEW.principal_id, NEW.idempotency_key, NEW.request_digest, NEW.admission_id,
      NEW.authority_epoch, NEW.target_profile, NEW.use_scope, NEW.created_at) THEN
    RAISE EXCEPTION 'immutable export request identity' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'sealed' THEN
    IF NEW.member_count <> (SELECT count(*) FROM export.member WHERE manifest_id = NEW.id)
       OR NEW.residual_count <> (SELECT count(*) FROM export.residual WHERE manifest_id = NEW.id) THEN
      RAISE EXCEPTION 'sealed export counts differ from recorded parts' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM export.member m WHERE m.manifest_id = NEW.id AND m.mapping <> 'unmapped'
               AND NOT EXISTS (SELECT 1 FROM export.member_basis b
                               WHERE b.manifest_id = m.manifest_id AND b.member_ordinal = m.ordinal)) THEN
      RAISE EXCEPTION 'every exported member requires a rights basis' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifest_guard BEFORE UPDATE OR DELETE ON export.manifest
  FOR EACH ROW EXECUTE FUNCTION export.manifest_guard();
