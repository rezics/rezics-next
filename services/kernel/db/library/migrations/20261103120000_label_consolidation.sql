-- migrate:up
-- One finite composition per owner, including cancelled/completed results until expiry or removal.
CREATE TABLE library.label_consolidation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  account_id uuid NOT NULL,
  consolidation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 32768),
  PRIMARY KEY (route, account_id),
  UNIQUE (route, account_id, consolidation_id)
);
CREATE INDEX label_consolidation_due ON library.label_consolidation
  (partition_no, expires_at, route, account_id);

-- migrate:down
DROP TABLE library.label_consolidation;
