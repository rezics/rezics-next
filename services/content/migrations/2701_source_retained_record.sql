-- Registered normalized records extend the existing conversion inventory. A
-- zero field_count is restricted to this reviewed variable-field adapter; legacy
-- provider mappings keep their sealed, fixed declarations and checks.
ALTER TABLE source.field_mapping ADD COLUMN normalization_revision text
  CHECK (normalization_revision = 'dataset-record-normalization-v1');
ALTER TABLE source.field_mapping DROP CONSTRAINT field_mapping_field_count_check;
ALTER TABLE source.field_mapping ADD CONSTRAINT field_mapping_field_count_check
  CHECK ((normalization_revision IS NULL AND field_count BETWEEN 1 AND 1024)
    OR (normalization_revision = 'dataset-record-normalization-v1' AND field_count = 0));

INSERT INTO source.field_mapping
  (mapping_revision,provider,namespace,root_grain,field_count,normalization_revision)
SELECT provider || '-' || namespace || '-retained-map-v1',provider,namespace,namespace,0,
  'dataset-record-normalization-v1'
FROM (VALUES
  ('vndb','vn'),('vndb','release'),('vndb','character'),('vndb','staff'),('vndb','producer'),
  ('vndb','tag'),('vndb','trait'),('vndb','language'),('vndb','platform'),('vndb','image'),('vndb','wikidata'),
  ('bangumi','subject'),('bangumi','person'),('bangumi','character'),('bangumi','episode'),('bangumi','tag'),
  ('musicbrainz','artist'),('musicbrainz','label'),('musicbrainz','release'),('musicbrainz','release-group'),
  ('musicbrainz','recording'),('musicbrainz','work'),('musicbrainz','area'),('musicbrainz','place'),
  ('musicbrainz','event'),('musicbrainz','series'),('musicbrainz','instrument'),('musicbrainz','url')
) AS mappings(provider,namespace);

CREATE OR REPLACE FUNCTION source.check_conversion_field_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.mapping_revision = 'open-library-work-map-v1' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM source.field_mapping WHERE mapping_revision = NEW.mapping_revision
      AND normalization_revision = 'dataset-record-normalization-v1') THEN
    IF NEW.projection->>'profile' IS DISTINCT FROM 'source-retained-record-projection-v1'
      OR jsonb_array_length(NEW.field_inventory) > 8192
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.field_inventory) item WHERE
        jsonb_typeof(item) <> 'object' OR item->>'pointer' NOT LIKE '/%'
        OR item->>'grain' IS NULL OR item->>'field' IS NULL OR item->>'reason' IS NULL
        OR item->>'disposition' NOT IN ('candidate','source-only','unmapped','delegated')) THEN
      RAISE EXCEPTION 'retained inventory differs from registered adapter'
        USING ERRCODE = '23514', CONSTRAINT = 'conversion_field_inventory';
    END IF;
    RETURN NEW;
  END IF;
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

-- The first observation may belong to a part record. record_id below always
-- denotes the separately resolved original provider/namespace/external identity.
CREATE TABLE source.retained_record_binding (
  id uuid PRIMARY KEY,
  conversion_id uuid NOT NULL UNIQUE REFERENCES source.conversion(id),
  principal_id uuid NOT NULL,
  record_id uuid NOT NULL REFERENCES source.record(id),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'
    AND request->>'profile' = 'source-retained-record-conversion-v1'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  normalization_revision text NOT NULL CHECK (normalization_revision = 'dataset-record-normalization-v1'),
  normalization_rule text NOT NULL CHECK (length(normalization_rule) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX retained_record_binding_principal ON source.retained_record_binding (principal_id,id);
CREATE INDEX retained_record_binding_record ON source.retained_record_binding (record_id,principal_id,id);
CREATE TRIGGER source_retained_record_binding_immutable BEFORE UPDATE OR DELETE ON source.retained_record_binding
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();

CREATE FUNCTION source.check_retained_record_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM source.conversion c
      JOIN source.field_mapping m ON m.mapping_revision=c.mapping_revision
      JOIN source.record r ON r.id=NEW.record_id
      WHERE c.id=NEW.conversion_id AND c.principal_id=NEW.principal_id
        AND m.normalization_revision=NEW.normalization_revision
        AND c.mapping_revision=NEW.request->>'mappingRevision'
        AND c.source_digest=NEW.request#>>'{retained,payload,byteDigest}'
        AND c.observation_id::text = split_part(NEW.request#>>'{retained,intakes,0,observation}', '/', 5)
        AND r.provider=NEW.request#>>'{retained,identity,provider}' AND r.provider=m.provider
        AND r.namespace=NEW.request#>>'{retained,identity,namespace}' AND r.namespace=m.namespace
        AND r.external_id=NEW.request#>>'{retained,identity,externalId}') THEN
    RAISE EXCEPTION 'retained binding differs from conversion or original record'
      USING ERRCODE = '23514', CONSTRAINT = 'retained_record_conversion';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_retained_record_binding_check BEFORE INSERT ON source.retained_record_binding
  FOR EACH ROW EXECUTE FUNCTION source.check_retained_record_binding();
