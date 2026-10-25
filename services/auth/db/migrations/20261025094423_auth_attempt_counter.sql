-- migrate:up
-- Operational protection only: crash recovery may clear UNLOGGED counters.
CREATE UNLOGGED TABLE auth_attempt_counter (
  key text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
  count integer NOT NULL CHECK (count > 0),
  last_request timestamptz NOT NULL,
  accepted boolean NOT NULL
);
CREATE INDEX auth_attempt_counter_retention ON auth_attempt_counter (last_request, key);

-- migrate:down
DROP TABLE auth_attempt_counter;
