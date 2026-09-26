-- Rights basis for source and native material, beside the source records and
-- Content variants it concerns. A use assessment records the evidenced basis
-- for one material, use and declared use scope; it is not legal clearance, not
-- an Access grant and never inherited by a different use. Complaint decisions
-- and restrictions stay in Access governance; intake rights_evidence is input.
CREATE SCHEMA IF NOT EXISTS rights;

CREATE FUNCTION rights.no_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable rights record' USING ERRCODE = '23514';
END $$;

-- Stable material identity: a provider surface, a source record component, a
-- native Content variant component or a media asset. Facts and expression are
-- distinguished here so factual entry never borrows expressive-copy conclusions.
CREATE TABLE rights.material (
  id uuid PRIMARY KEY,
  scope_kind text NOT NULL CHECK (scope_kind IN
    ('source_provider', 'source_record', 'content_variant', 'media_asset')),
  provider text CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 100),
  namespace text CHECK (namespace IS NULL OR length(namespace) BETWEEN 1 AND 100),
  source_record_id uuid REFERENCES source.record(id),
  content_variant_id text REFERENCES content.variant(id),
  media_asset text CHECK (media_asset IS NULL OR media_asset ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  component text NOT NULL CHECK (component ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  expression_kind text NOT NULL CHECK (expression_kind IN
    ('fact', 'expression', 'compilation', 'media', 'service', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope_kind = 'source_provider') = (provider IS NOT NULL AND namespace IS NOT NULL)),
  CHECK ((scope_kind = 'source_record') = (source_record_id IS NOT NULL)),
  CHECK ((scope_kind = 'content_variant') = (content_variant_id IS NOT NULL)),
  CHECK ((scope_kind = 'media_asset') = (media_asset IS NOT NULL)),
  CHECK ((scope_kind = 'source_provider') = (expression_kind = 'service'))
);
CREATE UNIQUE INDEX material_scope_idx ON rights.material
  (scope_kind, provider, namespace, source_record_id, content_variant_id, media_asset, component)
  NULLS NOT DISTINCT;
CREATE INDEX material_source_record_idx ON rights.material (source_record_id, component)
  WHERE source_record_id IS NOT NULL;
CREATE INDEX material_content_variant_idx ON rights.material (content_variant_id, component)
  WHERE content_variant_id IS NOT NULL;
CREATE TRIGGER material_immutable BEFORE UPDATE OR DELETE ON rights.material
  FOR EACH ROW EXECUTE FUNCTION rights.no_mutation();

-- Immutable assessment revisions. Data-rights and service-terms assessments are
-- separate families: API retention terms never decide copyright, and vice versa.
-- Unknown basis stays undetermined; fair use keeps its rationale and extent.
CREATE TABLE rights.use_assessment (
  id uuid PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES rights.material(id),
  family text NOT NULL CHECK (family IN ('data_rights', 'service_terms')),
  use_kind text NOT NULL CHECK (use_kind IN ('acquisition', 'raw_retention', 'wiki_display',
    'search', 'media_delivery', 'quotation', 'export', 'paid_data_product', 'redistribution')),
  use_scope text NOT NULL CHECK (use_scope ~ '^[a-z0-9][a-z0-9:_./-]{0,127}$'),
  basis text NOT NULL CHECK (basis IN ('original_contribution', 'unprotected_fact', 'public_domain',
    'license', 'permission', 'statutory_exception', 'service_terms', 'unknown')),
  outcome text NOT NULL CHECK (outcome IN ('supported', 'conditional', 'not_supported', 'undetermined')),
  license_instrument text CHECK (license_instrument IS NULL OR (length(license_instrument) <= 512
    AND license_instrument ~ '^https?://[^[:space:]]+$')),
  exception_kind text CHECK (exception_kind IN ('fair_use')),
  rationale text CHECK (rationale IS NULL OR (length(rationale) BETWEEN 1 AND 8000
    AND rationale = btrim(rationale))),
  extent jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extent) = 'object'
    AND octet_length(extent::text) <= 4096),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'
    AND octet_length(evidence::text) <= 16384),
  predecessor_id uuid UNIQUE,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  assessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (material_id, family, use_kind, use_scope, id),
  FOREIGN KEY (material_id, family, use_kind, use_scope, predecessor_id)
    REFERENCES rights.use_assessment(material_id, family, use_kind, use_scope, id),
  CHECK ((basis = 'license') = (license_instrument IS NOT NULL)),
  CHECK ((basis = 'statutory_exception') = (exception_kind IS NOT NULL)),
  CHECK (basis <> 'statutory_exception' OR (rationale IS NOT NULL AND extent <> '{}'::jsonb)),
  CHECK (basis <> 'unknown' OR outcome = 'undetermined'),
  CHECK ((family = 'service_terms') = (basis = 'service_terms'))
);
CREATE INDEX use_assessment_principal_idx ON rights.use_assessment (principal_id, id);
CREATE TRIGGER use_assessment_immutable BEFORE UPDATE OR DELETE ON rights.use_assessment
  FOR EACH ROW EXECUTE FUNCTION rights.no_mutation();

-- Current assessment per exact material/use key, advanced by CAS. A changed use
-- has a different key and starts without the earlier conclusion.
CREATE TABLE rights.use_assessment_head (
  material_id uuid NOT NULL,
  family text NOT NULL,
  use_kind text NOT NULL,
  use_scope text NOT NULL,
  assessment_id uuid NOT NULL UNIQUE,
  revision bigint NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (material_id, family, use_kind, use_scope),
  FOREIGN KEY (material_id, family, use_kind, use_scope, assessment_id)
    REFERENCES rights.use_assessment(material_id, family, use_kind, use_scope, id)
);

CREATE FUNCTION rights.guard_use_assessment_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rights assessment head cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR EXISTS (SELECT 1 FROM rights.use_assessment a
      WHERE a.id = NEW.assessment_id AND a.predecessor_id IS NOT NULL) THEN
      RAISE EXCEPTION 'first rights assessment head has no predecessor' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.material_id <> OLD.material_id OR NEW.family <> OLD.family OR NEW.use_kind <> OLD.use_kind
    OR NEW.use_scope <> OLD.use_scope OR NEW.revision <> OLD.revision + 1
    OR NOT EXISTS (SELECT 1 FROM rights.use_assessment a
      WHERE a.id = NEW.assessment_id AND a.predecessor_id = OLD.assessment_id) THEN
    RAISE EXCEPTION 'rights assessment head must advance to its successor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER use_assessment_head_guard BEFORE INSERT OR UPDATE OR DELETE ON rights.use_assessment_head
  FOR EACH ROW EXECUTE FUNCTION rights.guard_use_assessment_head();

-- Attribution, ShareAlike and notice obligations carried with the assessment
-- that relies on the instrument, so mapping and export keep them exactly.
CREATE TABLE rights.obligation (
  assessment_id uuid NOT NULL REFERENCES rights.use_assessment(id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 16),
  kind text NOT NULL CHECK (kind IN ('attribution', 'share_alike', 'notice_retention',
    'change_indication', 'non_commercial', 'no_derivatives', 'other')),
  instrument text NOT NULL CHECK (length(instrument) <= 512 AND instrument ~ '^https?://[^[:space:]]+$'),
  applies_to text NOT NULL CHECK (applies_to IN ('display', 'export', 'redistribution', 'all')),
  notice text CHECK (notice IS NULL OR length(notice) BETWEEN 1 AND 4000),
  PRIMARY KEY (assessment_id, ordinal)
);
CREATE TRIGGER obligation_immutable BEFORE UPDATE OR DELETE ON rights.obligation
  FOR EACH ROW EXECUTE FUNCTION rights.no_mutation();
