CREATE TABLE content.derivation (
  id text PRIMARY KEY,
  ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  output_revision uuid NOT NULL REFERENCES content.revision(id),
  operation_id text NOT NULL UNIQUE,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object')
);
CREATE INDEX content_derivation_output_page ON content.derivation(output_revision,ordinal);
CREATE TRIGGER content_derivation_immutable BEFORE UPDATE OR DELETE ON content.derivation
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();
