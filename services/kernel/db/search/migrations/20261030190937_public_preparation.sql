-- migrate:up
-- Operational locators/frontiers only. Native Source and consumer custody retain all authority.
CREATE TABLE search.public_preparation (
  partition_no integer NOT NULL CHECK (partition_no = 0),
  prefix text COLLATE "C" NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('population', 'repair')),
  locator jsonb NOT NULL CHECK (octet_length(locator::text) <= 131072),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  due_at bigint NOT NULL,
  lease_until bigint NOT NULL DEFAULT 0,
  expires_at bigint NOT NULL,
  PRIMARY KEY (partition_no, id)
);
CREATE UNIQUE INDEX public_preparation_locator ON search.public_preparation
  (partition_no, prefix, kind, (locator ->> 'key'));
CREATE INDEX public_preparation_due ON search.public_preparation
  (partition_no, prefix, due_at, id);
-- migrate:down
DROP TABLE search.public_preparation;
