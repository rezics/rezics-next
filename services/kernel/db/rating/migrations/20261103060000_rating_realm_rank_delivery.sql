-- migrate:up
-- Source-local membership/eligibility and target-local delivery frontiers survive row removal.
CREATE TABLE rating.realm_rank_delivery (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  consumer text NOT NULL CHECK (consumer IN ('membership', 'eligibility', 'aggregate')),
  key uuid[] NOT NULL CHECK (cardinality(key) BETWEEN 1 AND 4 AND array_position(key, NULL) IS NULL),
  epoch bigint NOT NULL CHECK (epoch > 0),
  position bigint NOT NULL CHECK (position > 0),
  revision integer NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (route, consumer, key)
);

-- migrate:down
-- Forward only: removing a frontier would permit obsolete membership epochs to count again.
SELECT 1;
