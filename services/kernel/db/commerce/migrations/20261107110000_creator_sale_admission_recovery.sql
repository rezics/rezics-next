-- migrate:up
-- Keep only the committed event key; reload protected order locators after role evidence arrives.
CREATE TABLE commerce.creator_sale_admission_recovery (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  position bigint NOT NULL CHECK (position >= 1),
  event_seq integer NOT NULL CHECK (event_seq BETWEEN 0 AND 999),
  epoch bigint NOT NULL CHECK (epoch >= 1),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'com.rezics.commerce.order.created.v1',
    'com.rezics.commerce.order.updated.v1'
  )),
  retry_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  PRIMARY KEY (partition_no,position,event_seq)
);

CREATE INDEX creator_sale_admission_recovery_due
  ON commerce.creator_sale_admission_recovery(partition_no,retry_at,position,event_seq);

-- migrate:down
DROP TABLE commerce.creator_sale_admission_recovery;
