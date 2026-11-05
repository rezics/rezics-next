-- migrate:up
-- Receiver copies of original owner receipts, not current permission or ACKs.
CREATE TABLE search.public_filter_coverage_baseline (
  partition_no integer NOT NULL,
  registration text COLLATE "C" NOT NULL,
  bootstrap uuid NOT NULL,
  source_home integer NOT NULL CHECK (source_home BETWEEN 0 AND 4095),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  source_position bigint NOT NULL CHECK (source_position >= 0),
  creation_position bigint NOT NULL CHECK (creation_position >= 0),
  native_enqueue_revision bigint NOT NULL CHECK (native_enqueue_revision >= 0),
  native_revision bigint,
  native_claim_revision bigint,
  receipt text NOT NULL CHECK (receipt ~ '^[0-9a-f]{64}$'),
  predecessor text NOT NULL CHECK (predecessor ~ '^[0-9a-f]{64}$'),
  root text NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (partition_no,registration,bootstrap,source_home),
  FOREIGN KEY (partition_no,registration) REFERENCES search.public_filter_registration(partition_no,id),
  CHECK ((native_revision IS NULL) = (native_claim_revision IS NULL)),
  CHECK (native_revision IS NULL OR (native_revision > 0 AND native_claim_revision > 0))
);
CREATE TABLE search.public_filter_coverage_preparation (
  partition_no integer NOT NULL,
  registration text COLLATE "C" NOT NULL,
  bootstrap uuid NOT NULL,
  definition uuid NOT NULL,
  consumer text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  after_home integer NOT NULL DEFAULT 0 CHECK (after_home BETWEEN 0 AND 4096),
  root text NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (partition_no,registration,bootstrap),
  FOREIGN KEY (partition_no,registration) REFERENCES search.public_filter_registration(partition_no,id)
);

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Coverage baseline receipts require retained retirement'; END $$;
