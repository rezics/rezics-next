-- migrate:up
CREATE TABLE core.consumer_checkpoint (
  partition_no integer NOT NULL REFERENCES core.partition (partition_no),
  consumer text NOT NULL CHECK (consumer ~ '^[a-z][a-z0-9_]{0,62}$'),
  epoch integer CHECK (epoch > 0),
  position bigint NOT NULL DEFAULT 0 CHECK (position >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partition_no, consumer),
  CHECK ((epoch IS NULL) = (position = 0))
);

-- migrate:down
DROP TABLE core.consumer_checkpoint;
