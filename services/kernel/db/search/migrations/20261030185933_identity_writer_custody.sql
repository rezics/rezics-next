-- migrate:up
-- The gate serializes first-absent close with enrollment, independently at each native home.
CREATE TABLE search.identity_writer_gate (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  physical_target text COLLATE "C" NOT NULL CHECK (octet_length(physical_target) BETWEEN 1 AND 255),
  consumer text COLLATE "C" NOT NULL CHECK (consumer ~ '^[a-z][a-z0-9_]{0,62}$'),
  incarnation text NOT NULL CHECK (octet_length(incarnation) BETWEEN 1 AND 128),
  write_alias text NOT NULL CHECK (octet_length(write_alias) BETWEEN 1 AND 255),
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  enrollment_generation bigint NOT NULL DEFAULT 0 CHECK (enrollment_generation >= 0),
  fence_generation bigint NOT NULL DEFAULT 0 CHECK (fence_generation >= 0),
  closed_token uuid,
  closed_transaction_id uuid,
  closed_position bigint CHECK (closed_position > 0),
  PRIMARY KEY (partition_no, physical_target),
  CHECK ((closed_token IS NULL) = (closed_transaction_id IS NULL)),
  CHECK ((closed_token IS NULL) = (closed_position IS NULL)),
  CHECK ((closed_token IS NULL) = (fence_generation = 0))
);
-- Pre-existing unresolved attempts have already been allowed to invoke their transport.
ALTER TABLE search.identity_writer ADD COLUMN dispatch_state text NOT NULL DEFAULT 'dispatched'
  CHECK (dispatch_state IN ('enrolled','dispatched','settled','cancelled'));
UPDATE search.identity_writer SET dispatch_state='settled' WHERE writer_token IS NULL;
ALTER TABLE search.identity_writer ALTER COLUMN dispatch_state SET DEFAULT 'enrolled';
ALTER TABLE search.identity_writer ADD COLUMN visible_transaction_id uuid;
ALTER TABLE search.identity_writer ADD COLUMN visible_position bigint CHECK (visible_position > 0);
ALTER TABLE search.identity_writer ADD CHECK ((visible_transaction_id IS NULL) = (visible_position IS NULL));
UPDATE search.identity_writer SET visible_transaction_id=settled_transaction_id,visible_position=settled_position
  WHERE source_position IS NOT NULL AND settled_transaction_id IS NOT NULL;
-- Native bounded drain discovery must not walk settled copy history.
CREATE INDEX identity_writer_pending ON search.identity_writer (partition_no,physical_target,original_id)
  WHERE writer_token IS NOT NULL;

-- migrate:down
DROP INDEX search.identity_writer_pending;
ALTER TABLE search.identity_writer DROP COLUMN visible_transaction_id, DROP COLUMN visible_position, DROP COLUMN dispatch_state;
DROP TABLE search.identity_writer_gate;
