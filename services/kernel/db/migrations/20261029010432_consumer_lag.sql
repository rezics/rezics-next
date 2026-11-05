-- migrate:up
CREATE TABLE core.consumer_lag (
  consumer text PRIMARY KEY,
  oldest_pending_at timestamp with time zone,
  observed_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT consumer_lag_consumer_check CHECK (consumer ~ '^[a-z][a-z0-9_]{0,62}$')
);

-- migrate:down
DROP TABLE core.consumer_lag;
