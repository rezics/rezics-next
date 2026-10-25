-- migrate:up
CREATE TABLE core.outbox (
  partition_no integer NOT NULL REFERENCES core.partition (partition_no),
  position bigint NOT NULL CHECK (position > 0),
  event_seq integer NOT NULL,
  event_count integer NOT NULL CHECK (event_count > 0),
  epoch integer NOT NULL,
  id uuid NOT NULL,
  type text NOT NULL,
  subject text,
  data jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partition_no, position, event_seq),
  CHECK (event_seq >= 0 AND event_seq < event_count)
);

-- migrate:down
