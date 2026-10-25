-- migrate:up
-- Global storage: a class change must share the identity/family window.
CREATE UNLOGGED TABLE access.write_rate_counter (
  identity_digest text NOT NULL CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
  family text NOT NULL CHECK (family ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  count integer NOT NULL CHECK (count >= 0),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  PRIMARY KEY (identity_digest, family)
);
-- Supports later bounded retention; spends perform no cleanup.
CREATE INDEX write_rate_counter_expiry ON access.write_rate_counter (expires_at);

-- migrate:down
DROP TABLE access.write_rate_counter;
