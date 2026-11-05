-- migrate:up
ALTER TABLE search.public_filter_registration
  ADD COLUMN coverage_generation bigint NOT NULL DEFAULT 0 CHECK (coverage_generation >= 0);
CREATE TABLE search.public_filter_coverage_home (
  partition_no integer NOT NULL,
  registration text COLLATE "C" NOT NULL,
  source_home integer NOT NULL CHECK (source_home BETWEEN 0 AND 4095),
  source_epoch integer NOT NULL CHECK (source_epoch > 0),
  relevant_position bigint NOT NULL CHECK (relevant_position >= 0),
  acknowledged_position bigint NOT NULL DEFAULT 0 CHECK (acknowledged_position >= 0),
  native_enqueue_revision bigint NOT NULL DEFAULT 0 CHECK (native_enqueue_revision >= 0),
  native_revision bigint,
  native_claim_revision bigint,
  acknowledged_native_revision bigint,
  acknowledged_native_claim_revision bigint,
  last_change_generation bigint NOT NULL CHECK (last_change_generation > 0),
  behind boolean NOT NULL DEFAULT true,
  PRIMARY KEY (partition_no,registration,source_home),
  FOREIGN KEY (partition_no,registration) REFERENCES search.public_filter_registration(partition_no,id)
);
CREATE INDEX public_filter_coverage_behind ON search.public_filter_coverage_home
  USING btree(partition_no,registration,source_home) WHERE behind;
CREATE INDEX public_filter_coverage_changed ON search.public_filter_coverage_home
  USING btree(partition_no,registration,last_change_generation,source_home);

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Native coverage summaries retain Source obligations'; END $$;
