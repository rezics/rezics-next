ALTER TABLE source.observation DROP CONSTRAINT observation_check;

ALTER TABLE source.observation ADD CONSTRAINT observation_raw_retention_size_check CHECK (
  (retention = 'retained' AND raw_bytes IS NOT NULL AND byte_digest IS NOT NULL
    AND octet_length(raw_bytes) <= 262144)
  OR (retention = 'not-retained' AND raw_bytes IS NULL AND byte_digest IS NULL)
);
