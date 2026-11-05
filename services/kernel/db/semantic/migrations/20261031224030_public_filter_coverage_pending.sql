-- migrate:up
-- A live key/home interval is a barrier until native reverse-enrolment maintenance
-- adopts its real receipts. It is neither a permission nor a replacement log.
CREATE TABLE semantic.public_filter_privacy_pending (
  partition_no integer NOT NULL REFERENCES semantic.public_filter_privacy_head(partition_no),
  input_key text COLLATE "C" NOT NULL,
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  first_position bigint NOT NULL CHECK (first_position > 0),
  through_position bigint NOT NULL,
  enqueue_revision bigint NOT NULL CHECK (enqueue_revision > 0),
  captured_through bigint,
  captured_revision bigint,
  captured_epoch integer,
  fanout_frontier text,
  PRIMARY KEY (partition_no, input_key),
  CHECK (through_position >= first_position),
  CHECK ((captured_through IS NULL) = (captured_revision IS NULL)),
  CHECK ((captured_through IS NULL) = (captured_epoch IS NULL)),
  CHECK (captured_through IS NULL OR
    (captured_through BETWEEN first_position AND through_position AND
     captured_revision > 0 AND captured_revision <= enqueue_revision AND captured_epoch > 0))
);
CREATE INDEX public_filter_privacy_pending_key
  ON semantic.public_filter_privacy_pending USING btree (input_key, partition_no);

-- Survives retirement of pending routing work. Missing means unknown, never a
-- fabricated zero subject version. This contains no selected values or allow bit.
CREATE TABLE semantic.public_filter_privacy_subject (
  partition_no integer NOT NULL REFERENCES semantic.public_filter_privacy_head(partition_no),
  route integer NOT NULL CHECK (route >= partition_no * 16 AND route < (partition_no + 1) * 16),
  subject_id uuid NOT NULL,
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  position bigint NOT NULL CHECK (position > 0),
  PRIMARY KEY (partition_no, subject_id)
);

-- migrate:down
-- Losing a barrier or an own-row version while a cut survives is unsafe.
DO $$ BEGIN RAISE EXCEPTION 'Public filter coverage barriers require native retirement before rollback'; END $$;
