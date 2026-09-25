CREATE TABLE source.conversion (
  id uuid PRIMARY KEY,
  observation_id uuid NOT NULL REFERENCES source.observation(id),
  principal_id uuid NOT NULL,
  mapping_revision text NOT NULL CHECK (mapping_revision = 'open-library-work-map-v1'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  field_inventory jsonb NOT NULL CHECK (jsonb_typeof(field_inventory) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (observation_id, mapping_revision)
);
CREATE INDEX conversion_principal_idx ON source.conversion (principal_id, id);
CREATE TRIGGER source_conversion_immutable BEFORE UPDATE OR DELETE ON source.conversion
  FOR EACH ROW EXECUTE FUNCTION source.no_mutation();
