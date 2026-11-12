-- migrate:up
-- Owner-private exact hosted Book checkpoint. One row per owner and Subject.
-- Page units stay on ordinary Progress; this fact stores the exact catalogue selection.
CREATE TABLE library.hosted_reading (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  catalogue_id uuid NOT NULL,
  publication_revision_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  target_sha256 bytea NOT NULL CHECK (octet_length(target_sha256) = 32),
  document_block_id text,
  document_offset integer,
  revision bigint NOT NULL CHECK (revision > 0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (route, account_id, subject_id),
  CONSTRAINT hosted_reading_account_route_check
    CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CONSTRAINT hosted_reading_position_check
    CHECK ((document_block_id IS NULL) = (document_offset IS NULL)),
  CONSTRAINT hosted_reading_block_check
    CHECK (document_block_id IS NULL OR (char_length(document_block_id) BETWEEN 1 AND 128)),
  CONSTRAINT hosted_reading_offset_check
    CHECK (document_offset IS NULL OR (document_offset BETWEEN 0 AND 2097152))
);

-- migrate:down
DROP TABLE library.hosted_reading;
