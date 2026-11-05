-- migrate:up
CREATE TABLE semantic.source_record (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  source text NOT NULL,
  external_id text NOT NULL,
  metadata_revision integer NOT NULL CHECK (metadata_revision > 0),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, source, external_id)
);

-- migrate:down
DROP TABLE semantic.source_record;
