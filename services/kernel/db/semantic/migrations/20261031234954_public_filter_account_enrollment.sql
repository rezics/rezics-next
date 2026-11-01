-- migrate:up
-- Account tuples remain in their native domain. Neither revision is a Semantic
-- privacy-log position. Queue revisions order this coalesced key under its home lock.
ALTER TABLE semantic.public_filter_privacy_pending
  ALTER COLUMN first_position DROP NOT NULL,
  ALTER COLUMN through_position DROP NOT NULL,
  ADD COLUMN live boolean NOT NULL DEFAULT true,
  ADD COLUMN next_first_position bigint,
  ADD COLUMN native_captured_enqueue bigint,
  ADD COLUMN native_captured_epoch integer,
  ADD COLUMN native_revision bigint,
  ADD COLUMN native_claim_revision bigint,
  ADD COLUMN native_transaction xid8,
  ADD COLUMN captured_native_revision bigint,
  ADD COLUMN captured_native_claim_revision bigint,
  ADD CONSTRAINT public_filter_pending_native_domain CHECK (
    (input_key = '["domain","accounts"]' AND first_position IS NULL AND through_position IS NULL
      AND native_revision IS NOT NULL AND native_revision > 0
      AND native_claim_revision IS NOT NULL AND native_claim_revision > 0
      AND native_transaction IS NOT NULL)
    OR (input_key <> '["domain","accounts"]' AND first_position IS NOT NULL AND through_position IS NOT NULL
      AND native_revision IS NULL AND native_claim_revision IS NULL AND native_transaction IS NULL)
  );

DROP INDEX semantic.public_filter_privacy_pending_key;
CREATE INDEX public_filter_privacy_pending_home ON semantic.public_filter_privacy_pending
  USING btree(partition_no,input_key) WHERE live;
CREATE INDEX public_filter_privacy_pending_key ON semantic.public_filter_privacy_pending
  USING btree(input_key,partition_no) WHERE live;

-- Enrollment and its original baseline live in the actual writer home. Repeated
-- preparation reads this original row, never restamps it from a newer owner head.
CREATE TABLE semantic.public_filter_home_enrollment (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  bootstrap uuid NOT NULL,
  registration_partition integer NOT NULL CHECK (registration_partition BETWEEN 0 AND 4095),
  registration text COLLATE "C" NOT NULL,
  read_definition uuid NOT NULL,
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position >= 0),
  native_revision bigint,
  native_claim_revision bigint,
  key_after text COLLATE "C",
  complete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (partition_no, bootstrap),
  CHECK ((native_revision IS NULL) = (native_claim_revision IS NULL))
);
CREATE TABLE semantic.public_filter_key_enrollment (
  partition_no integer NOT NULL,
  input_key text COLLATE "C" NOT NULL,
  registration_partition integer NOT NULL,
  registration text COLLATE "C" NOT NULL,
  bootstrap uuid NOT NULL,
  PRIMARY KEY (partition_no, input_key, registration_partition, registration, bootstrap),
  FOREIGN KEY (partition_no, bootstrap)
    REFERENCES semantic.public_filter_home_enrollment(partition_no, bootstrap)
);

-- All Account/claim origins call this from their authoritative transaction after
-- taking population then Source-head locks. It never opens a foreign home.
CREATE FUNCTION semantic.enqueue_account_public_filter(
  home integer, account_revision bigint, claim_revision bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE owner integer;
BEGIN
  SELECT epoch INTO owner FROM core.partition
    WHERE partition_no=home AND write_state='active';
  IF owner IS NULL THEN RAISE EXCEPTION 'Account public-filter owner is unavailable'; END IF;
  PERFORM 1 FROM semantic.public_filter_privacy_head WHERE partition_no=home FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account public-filter Source head is missing'; END IF;
  INSERT INTO semantic.public_filter_privacy_pending
    (partition_no,input_key,owner_epoch,first_position,through_position,enqueue_revision,
     native_revision,native_claim_revision,native_transaction)
  VALUES (home,'["domain","accounts"]',owner,NULL,NULL,1,
    account_revision,claim_revision,pg_current_xact_id())
  ON CONFLICT (partition_no,input_key) DO UPDATE SET
    owner_epoch=EXCLUDED.owner_epoch,
    enqueue_revision=semantic.public_filter_privacy_pending.enqueue_revision+1,
    native_revision=EXCLUDED.native_revision,
    native_claim_revision=EXCLUDED.native_claim_revision,
    native_transaction=EXCLUDED.native_transaction,
    live=true;
END $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Source enrollment custody cannot be rolled back'; END $$;
