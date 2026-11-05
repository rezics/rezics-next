-- migrate:up
-- Operational in-flight custody only. No Source, mapping, permission or canonical support is stored here.
CREATE TABLE search.identity_writer (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  physical_target text COLLATE "C" NOT NULL CHECK (octet_length(physical_target) BETWEEN 1 AND 255),
  original_id uuid NOT NULL,
  incarnation text NOT NULL CHECK (octet_length(incarnation) BETWEEN 1 AND 128),
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  writer_token uuid,
  writer_transaction_id uuid,
  writer_position bigint CHECK (writer_position > 0),
  settled_transaction_id uuid,
  settled_position bigint CHECK (settled_position > 0),
  source_position bigint CHECK (source_position >= 0),
  closed_job uuid,
  closed_epoch bigint CHECK (closed_epoch > 0),
  closed_transaction_id uuid,
  closed_position bigint CHECK (closed_position > 0),
  PRIMARY KEY (partition_no, physical_target, original_id),
  CHECK ((writer_transaction_id IS NULL) = (writer_position IS NULL)),
  CHECK (writer_token IS NULL OR writer_transaction_id IS NOT NULL),
  CHECK ((settled_transaction_id IS NULL) = (settled_position IS NULL)),
  CHECK ((closed_job IS NULL) = (closed_epoch IS NULL)),
  CHECK ((closed_job IS NULL) = (closed_transaction_id IS NULL)),
  CHECK ((closed_job IS NULL) = (closed_position IS NULL))
);

-- migrate:down
DROP TABLE search.identity_writer;
