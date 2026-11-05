-- migrate:up
-- A job is a bounded reconciliation frontier over an existing native generation, not a generation registry.
CREATE TABLE search.generation_publication (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  job uuid NOT NULL,
  physical_target text COLLATE "C" NOT NULL,
  consumer jsonb NOT NULL CHECK (octet_length(consumer::text)<=8192),
  prefix text COLLATE "C" NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  family text NOT NULL CHECK (family IN ('subjects','discovery')),
  native_incarnation text NOT NULL,
  pass bigint NOT NULL DEFAULT 1 CHECK (pass>0),
  activated_at text NOT NULL,
  kinds text[] NOT NULL,
  source_home integer NOT NULL CHECK (source_home BETWEEN 0 AND 4095),
  binding jsonb NOT NULL CHECK (octet_length(binding::text)<=8192),
  phase text NOT NULL DEFAULT 'subject' CHECK (phase IN ('subject','account','engine','validate','reconciled','fencing','intent','active')),
  home integer NOT NULL DEFAULT 0 CHECK (home BETWEEN 0 AND 4096),
  after_route integer,
  after_id uuid,
  engine_after jsonb CHECK (octet_length(engine_after::text)<=8192),
  pit text CHECK (octet_length(pit)<=65536),
  fence text CHECK (octet_length(fence)<=8192),
  fenced_pass boolean NOT NULL DEFAULT false,
  observation text,
  previous_target text,
  previous_uuid text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY(partition_no,job),
  UNIQUE(partition_no,physical_target,consumer),
  CHECK ((after_route IS NULL)=(after_id IS NULL))
);
CREATE TABLE search.generation_publication_home (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  job uuid NOT NULL,
  pass bigint NOT NULL CHECK (pass>0),
  epoch integer NOT NULL,
  position bigint NOT NULL CHECK (position>=0),
  account_revision bigint NOT NULL DEFAULT 0,
  claim_revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(partition_no,job)
);
CREATE INDEX generation_publication_home_frontier
  ON search.generation_publication_home(job,pass,partition_no);
CREATE INDEX public_filter_registration_publication
  ON search.public_filter_registration(physical_target,md5(consumer),partition_no) WHERE state='active';
CREATE INDEX public_filter_observation_publication
  ON search.public_filter_observation(partition_no,registration,observation DESC) WHERE state='open';
ALTER TABLE search.identity_writer_gate
  ADD COLUMN publication_job uuid,
  ADD COLUMN publication_consumer jsonb CHECK (octet_length(publication_consumer::text)<=8192),
  ADD COLUMN publication_fence uuid,
  ADD COLUMN publication_released_fence uuid,
  ADD COLUMN publication_home integer NOT NULL DEFAULT 0 CHECK (publication_home BETWEEN 0 AND 4096),
  ADD COLUMN publication_after uuid,
  ADD COLUMN publication_revision bigint NOT NULL DEFAULT 0 CHECK (publication_revision>=0),
  ADD CHECK (publication_fence IS NULL OR (publication_job IS NOT NULL AND publication_consumer IS NOT NULL)),
  ADD CHECK (partition_no=0 OR publication_job IS NULL);
-- migrate:down
-- Forward only: publication intent and an unreleased native fence must survive binary rollback.
