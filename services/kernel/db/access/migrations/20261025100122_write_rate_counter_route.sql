-- migrate:up
-- Operational windows may reset during placement changes. Existing digests do
-- not reveal the verified acting account's route, so discard those windows.
TRUNCATE access.write_rate_counter;
ALTER TABLE access.write_rate_counter
  ADD COLUMN route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  DROP CONSTRAINT write_rate_counter_pkey,
  ADD PRIMARY KEY (route, identity_digest, family);
DROP INDEX access.write_rate_counter_expiry;
-- Later retention runs bounded batches in each counter's home partition.
CREATE INDEX write_rate_counter_expiry
  ON access.write_rate_counter (route, expires_at, identity_digest, family);

-- migrate:down
TRUNCATE access.write_rate_counter;
DROP INDEX access.write_rate_counter_expiry;
ALTER TABLE access.write_rate_counter
  DROP CONSTRAINT write_rate_counter_pkey,
  DROP COLUMN route,
  ADD PRIMARY KEY (identity_digest, family);
CREATE INDEX write_rate_counter_expiry ON access.write_rate_counter (expires_at);
