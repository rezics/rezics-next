CREATE TABLE content.projection_checkpoint (
  consumer text PRIMARY KEY CHECK (length(consumer) BETWEEN 1 AND 100),
  data_epoch uuid NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
