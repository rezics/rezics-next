-- migrate:up
-- Source-owned catalogue/configuration/read binding. Search remains the sole observation/engine writer.
CREATE TABLE semantic.public_filter_source (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  source_id uuid NOT NULL DEFAULT gen_random_uuid(),
  configuration uuid NOT NULL DEFAULT gen_random_uuid(),
  route_digest text NOT NULL,
  owner_epoch integer NOT NULL CHECK(owner_epoch > 0),
  family text NOT NULL CHECK(family = 'global-subject-v1'),
  PRIMARY KEY(partition_no, source_id),
  UNIQUE(partition_no, route_digest, owner_epoch, family),
  UNIQUE(partition_no, source_id, configuration)
);
CREATE TABLE semantic.public_filter_read_definition (
  partition_no integer NOT NULL,
  read_definition uuid NOT NULL DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  configuration uuid NOT NULL,
  release_digest text NOT NULL,
  subject_type text NOT NULL,
  capture_digest text NOT NULL,
  capture text NOT NULL CHECK(octet_length(capture) <= 1048576),
  dependency_keys jsonb NOT NULL CHECK(jsonb_typeof(dependency_keys) = 'array'),
  PRIMARY KEY(partition_no, read_definition),
  UNIQUE(partition_no, source_id, configuration, release_digest, subject_type, capture_digest),
  FOREIGN KEY(partition_no, source_id, configuration)
    REFERENCES semantic.public_filter_source(partition_no, source_id, configuration)
);
CREATE TABLE semantic.public_filter_bootstrap (
  partition_no integer NOT NULL,
  bootstrap uuid NOT NULL,
  read_definition uuid NOT NULL,
  request_key text NOT NULL,
  consumer text NOT NULL CHECK(octet_length(consumer) <= 16384),
  snapshot_kind text NOT NULL CHECK(snapshot_kind IN ('pit','prepared')),
  native_snapshot pg_snapshot NOT NULL,
  owner_epoch integer NOT NULL CHECK(owner_epoch > 0),
  source_position bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('capturing','begun','adopted','aborting','aborted')),
  account_after integer NOT NULL DEFAULT 0 CHECK(account_after BETWEEN 0 AND 4096),
  queried text,
  PRIMARY KEY(partition_no, bootstrap),
  FOREIGN KEY(partition_no, read_definition)
    REFERENCES semantic.public_filter_read_definition(partition_no, read_definition)
);
CREATE UNIQUE INDEX public_filter_bootstrap_capture ON semantic.public_filter_bootstrap
  (partition_no, request_key) WHERE state = 'capturing';
-- Retained ORIGINAL owner heads, never current truth or an Account allow cache.
CREATE TABLE semantic.public_filter_bootstrap_account (
  partition_no integer NOT NULL,
  bootstrap uuid NOT NULL,
  account_partition integer NOT NULL CHECK(account_partition BETWEEN 0 AND 4095),
  owner_epoch integer NOT NULL CHECK(owner_epoch > 0),
  revision bigint NOT NULL CHECK(revision > 0),
  claim_revision bigint NOT NULL CHECK(claim_revision > 0),
  PRIMARY KEY(partition_no, bootstrap, account_partition),
  FOREIGN KEY(partition_no, bootstrap) REFERENCES semantic.public_filter_bootstrap(partition_no, bootstrap)
);
CREATE TABLE semantic.public_filter_repair_step (
  partition_no integer NOT NULL,
  bootstrap uuid NOT NULL,
  execution text NOT NULL,
  step uuid NOT NULL,
  predecessor uuid,
  state text NOT NULL CHECK(octet_length(state) <= 16384),
  complete boolean NOT NULL,
  PRIMARY KEY(partition_no, bootstrap, execution, step),
  UNIQUE(partition_no, bootstrap, execution, predecessor),
  FOREIGN KEY(partition_no, bootstrap) REFERENCES semantic.public_filter_bootstrap(partition_no, bootstrap)
);
CREATE UNIQUE INDEX public_filter_repair_root ON semantic.public_filter_repair_step
  (partition_no, bootstrap, execution) WHERE predecessor IS NULL;
-- Home-local Source advancement; no foreign Source position is used as an external version.
CREATE TABLE semantic.public_filter_repair_advance (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  bootstrap uuid NOT NULL,
  execution text NOT NULL,
  step uuid NOT NULL,
  route integer NOT NULL CHECK(route / 16 = partition_no),
  subject_id uuid NOT NULL,
  owner_epoch integer NOT NULL CHECK(owner_epoch > 0),
  position bigint NOT NULL CHECK(position > 0),
  PRIMARY KEY(partition_no, bootstrap, execution, step, route, subject_id)
);

-- migrate:down
DROP TABLE semantic.public_filter_repair_advance;
DROP TABLE semantic.public_filter_repair_step;
DROP TABLE semantic.public_filter_bootstrap_account;
DROP TABLE semantic.public_filter_bootstrap;
DROP TABLE semantic.public_filter_read_definition;
DROP TABLE semantic.public_filter_source;
