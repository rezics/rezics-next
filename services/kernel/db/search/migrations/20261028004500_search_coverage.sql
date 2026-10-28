-- migrate:up
CREATE SCHEMA search;

-- One permanent allocation fence per prefix; reclaimed physical names cannot be reissued.
CREATE TABLE search.index_prefix_control (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no = 0),
  prefix text COLLATE "C" NOT NULL CHECK (prefix ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  issued_generation bigint NOT NULL CHECK (issued_generation BETWEEN 1 AND 9007199254740991),
  allocation_bound boolean NOT NULL DEFAULT false,
  PRIMARY KEY (partition_no, prefix)
);

CREATE TABLE search.index_incarnation (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no = 0),
  consumer text COLLATE "C" NOT NULL CHECK (octet_length(consumer) BETWEEN 1 AND 63),
  index_uuid text COLLATE "C" NOT NULL CHECK (octet_length(index_uuid) BETWEEN 1 AND 128),
  prefix text COLLATE "C" NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  index_name text COLLATE "C" NOT NULL CHECK (octet_length(index_name) BETWEEN 1 AND 255),
  protocol text NOT NULL CHECK (protocol = 'subject-coverage-v1'),
  revision bigint NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('populating', 'live', 'quarantined', 'retiring')),
  origin text NOT NULL CHECK (origin IN ('created-empty', 'replay', 'audit')),
  population_partition integer NOT NULL CHECK (population_partition BETWEEN 0 AND 4096),
  population_after uuid,
  population_complete boolean NOT NULL,
  PRIMARY KEY (partition_no, consumer, index_uuid),
  UNIQUE (partition_no, prefix, generation),
  FOREIGN KEY (partition_no, prefix) REFERENCES search.index_prefix_control (partition_no, prefix),
  CHECK ((population_complete AND population_partition = 4096 AND population_after IS NULL)
      OR (NOT population_complete AND population_partition < 4096)),
  CHECK (state <> 'live' OR population_complete)
);

-- JSON is closed and decoded at the store boundary; fixed byte caps also bound damaged rows.
CREATE TABLE search.index_home_coverage (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  consumer text COLLATE "C" NOT NULL CHECK (octet_length(consumer) BETWEEN 1 AND 63),
  index_uuid text COLLATE "C" NOT NULL CHECK (octet_length(index_uuid) BETWEEN 1 AND 128),
  revision bigint NOT NULL CHECK (revision > 0),
  "current" jsonb CHECK (jsonb_typeof("current") = 'object' AND octet_length("current"::text) <= 2048),
  fence jsonb CHECK (jsonb_typeof(fence) = 'object' AND octet_length(fence::text) <= 512),
  verified jsonb CHECK (jsonb_typeof(verified) = 'object' AND octet_length(verified::text) <= 2048),
  covered_through jsonb CHECK (jsonb_typeof(covered_through) = 'object' AND octet_length(covered_through::text) <= 256),
  attempt jsonb CHECK (jsonb_typeof(attempt) = 'object' AND octet_length(attempt::text) <= 4096),
  PRIMARY KEY (partition_no, consumer, index_uuid),
  CHECK (("current" IS NULL) = (fence IS NULL)),
  CHECK ((verified IS NULL) = (covered_through IS NULL))
);
CREATE INDEX index_home_coverage_retire ON search.index_home_coverage (consumer, index_uuid, partition_no);

-- migrate:down
-- Forward only: allocation fences must survive retirement and rollback.
