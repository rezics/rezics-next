-- A mapping revision declares one reviewed disposition per source field/grain. The
-- declaration is sealed with the mapping: a later field needs a new revision.
CREATE TABLE source.field_mapping (
  mapping_revision text PRIMARY KEY CHECK (mapping_revision ~ '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}$'),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 100),
  root_grain text NOT NULL CHECK (root_grain ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  field_count integer NOT NULL CHECK (field_count BETWEEN 1 AND 1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (mapping_revision <> 'open-library-work-map-v1')
);
CREATE TRIGGER source_field_mapping_immutable BEFORE UPDATE OR DELETE ON source.field_mapping
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

-- Provider statistics and provider accounts stay source data; they never become
-- native ballots or accounts (LIVE08). Native and lossy fields name one admitted
-- native slot as `<profile>#<slot>`; lossy fields name their concrete loss.
CREATE TABLE source.field_disposition (
  mapping_revision text NOT NULL REFERENCES source.field_mapping(mapping_revision),
  grain text NOT NULL CHECK (grain ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  field_key text NOT NULL CHECK (field_key ~ '^[A-Za-z0-9@$_][A-Za-z0-9@$_.:/#-]{0,199}$'),
  disposition text NOT NULL CHECK (disposition IN
    ('native', 'structured-source-only', 'lossy', 'excluded', 'unsupported')),
  value_kind text NOT NULL CHECK (value_kind IN ('identifier', 'text', 'language-text', 'time',
    'quantity', 'reference', 'term', 'structure', 'metadata', 'statistic', 'provider-account')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  native_target text CHECK (native_target ~ '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}#[A-Za-z0-9:_.-]{1,100}$'),
  loss text CHECK (length(loss) BETWEEN 1 AND 500 AND loss !~ '[[:cntrl:]]'),
  PRIMARY KEY (mapping_revision, grain, field_key),
  CHECK ((disposition IN ('native', 'lossy')) = (native_target IS NOT NULL)),
  CHECK ((disposition = 'lossy') = (loss IS NOT NULL)),
  CHECK (value_kind NOT IN ('statistic', 'provider-account') OR disposition NOT IN ('native', 'lossy'))
);
CREATE INDEX field_disposition_target_idx ON source.field_disposition (native_target, mapping_revision)
  WHERE native_target IS NOT NULL;
CREATE TRIGGER source_field_disposition_immutable BEFORE UPDATE OR DELETE ON source.field_disposition
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.check_field_mapping_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM source.field_disposition WHERE mapping_revision = NEW.mapping_revision)
      <> NEW.field_count THEN
    RAISE EXCEPTION 'field mapping must declare every disposition when registered'
      USING ERRCODE = '23514', CONSTRAINT = 'field_mapping_sealed';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER source_field_mapping_sealed AFTER INSERT ON source.field_mapping
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION source.check_field_mapping_sealed();

CREATE FUNCTION source.seal_field_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE declared integer;
BEGIN
  SELECT field_count INTO declared FROM source.field_mapping
    WHERE mapping_revision = NEW.mapping_revision FOR UPDATE;
  IF NOT FOUND OR (SELECT count(*) FROM source.field_disposition
      WHERE mapping_revision = NEW.mapping_revision) >= declared THEN
    RAISE EXCEPTION 'field mapping is sealed'
      USING ERRCODE = '23514', CONSTRAINT = 'field_mapping_sealed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_field_disposition_seal BEFORE INSERT ON source.field_disposition
  FOR EACH ROW EXECUTE FUNCTION source.seal_field_disposition();

-- The legacy Open Library inventory keeps its own vocabulary. Every other
-- conversion must use a registered mapping and give each observed field its
-- declared disposition; an undeclared field is explicitly unsupported (LIVE01).
ALTER TABLE source.conversion DROP CONSTRAINT conversion_mapping_revision_check;
ALTER TABLE source.conversion ADD CONSTRAINT conversion_mapping_revision_form
  CHECK (mapping_revision ~ '^[a-z0-9][a-z0-9-]{0,94}-v[1-9][0-9]{0,2}$');

CREATE FUNCTION source.check_conversion_field_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mapping_revision = 'open-library-work-map-v1' THEN RETURN NEW; END IF;
  PERFORM 1 FROM source.field_mapping WHERE mapping_revision = NEW.mapping_revision;
  IF NOT FOUND OR jsonb_array_length(NEW.field_inventory) > 1024 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.field_inventory) item
      LEFT JOIN source.field_disposition d ON d.mapping_revision = NEW.mapping_revision
        AND d.grain = item->>'grain' AND d.field_key = item->>'field'
      WHERE jsonb_typeof(item) <> 'object' OR item->>'grain' IS NULL OR item->>'field' IS NULL
        OR item->>'disposition' IS DISTINCT FROM COALESCE(d.disposition, 'unsupported')
        OR (d.field_key IS NULL AND item->>'reason' IS DISTINCT FROM 'undeclared-field'))
    OR (SELECT count(*) FROM jsonb_array_elements(NEW.field_inventory)) <> (SELECT count(*) FROM
      (SELECT DISTINCT item->>'grain', item->>'field' FROM jsonb_array_elements(NEW.field_inventory) item) fields) THEN
    RAISE EXCEPTION 'conversion field inventory differs from its declared mapping'
      USING ERRCODE = '23514', CONSTRAINT = 'conversion_field_inventory';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_conversion_field_inventory BEFORE INSERT ON source.conversion
  FOR EACH ROW EXECUTE FUNCTION source.check_conversion_field_inventory();
