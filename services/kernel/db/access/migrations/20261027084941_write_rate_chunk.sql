-- migrate:up
CREATE UNLOGGED TABLE access.write_rate_chunk (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
  operation_id uuid NOT NULL,
  chunk_index bigint NOT NULL CHECK (chunk_index BETWEEN 0 AND 9007199254740991),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  PRIMARY KEY (route, identity_digest, operation_id, chunk_index)
);
CREATE INDEX write_rate_chunk_expiry
  ON access.write_rate_chunk (route, expires_at, identity_digest, operation_id, chunk_index);

-- migrate:down
DROP TABLE access.write_rate_chunk;
