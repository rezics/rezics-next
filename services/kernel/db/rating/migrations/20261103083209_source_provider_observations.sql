-- migrate:up
ALTER TABLE rating.source_statistic DROP CONSTRAINT source_statistic_source_check;
ALTER TABLE rating.source_statistic
  ADD CONSTRAINT source_statistic_source_check CHECK (source IN ('vndb', 'bangumi')),
  ADD CONSTRAINT source_statistic_provider_check CHECK (
    scale_max <= 4096 AND
    (source = 'vndb' OR (scale_min = 0 AND scale_max = 10
      AND source_record_id ~ '^[1-9][0-9]*$'
      AND length(source_record_id) <= 16 AND
      CASE WHEN source_record_id ~ '^[1-9][0-9]{0,15}$' THEN source_record_id::numeric <= 9007199254740991 ELSE false END))),
  ADD COLUMN observation_digest text CHECK (observation_digest ~ '^[0-9a-f]{64}$');

-- Immutable content-addressed observations and one authoritative head, including clear tombstones.
-- Old VNDB rows are adopted by the command on their next change; no source revision is invented.
CREATE TABLE rating.source_statistic_observation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('vndb', 'bangumi')),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  source_alias text NOT NULL CHECK (source_alias ~ '^[a-z][a-z0-9_-]{0,31}$' AND source_alias !~ '[^a-z0-9_-]'),
  source_record_id text NOT NULL CHECK (octet_length(source_record_id) BETWEEN 1 AND 1024),
  CHECK (source = 'vndb' OR (source_record_id ~ '^[1-9][0-9]{0,15}$' AND
    CASE WHEN source_record_id ~ '^[1-9][0-9]{0,15}$' THEN source_record_id::numeric <= 9007199254740991 ELSE false END)),
  as_of date NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, source, digest),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (payload->>'sourceAlias' = source_alias AND payload->>'sourceRecordId' = source_record_id
    AND payload->>'asOf' = as_of::text)
);
CREATE TABLE rating.source_statistic_head (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  source text NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY (route, subject_id, source),
  FOREIGN KEY (route, subject_id, source, digest)
    REFERENCES rating.source_statistic_observation (route, subject_id, source, digest)
);

-- migrate:down
-- Forward only: source provenance and cleared observation heads must survive rollback.
