-- migrate:up
-- Derived references and checkpoints. Originals, personal pins and native facts remain immutable.
CREATE TABLE library.canonical_source_scope (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  source_fence text NOT NULL,
  identity jsonb NOT NULL CHECK(octet_length(identity::text)<=4096),
  frontier jsonb CHECK(octet_length(frontier::text)<=4096),
  capture_id uuid,
  committed_revision bigint,
  PRIMARY KEY(route,collection_id,source_fence),
  FOREIGN KEY(route,collection_id) REFERENCES library.collection(route,collection_id)
);
CREATE TABLE library.canonical_source_generation (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  basis jsonb NOT NULL CHECK(octet_length(basis::text)<=4096),
  driver text NOT NULL CHECK(driver IN ('member','entry','label','session','copy','output','done')),
  after_subject uuid,
  after_fact uuid,
  source_exhausted boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'working' CHECK(state IN ('working','complete','abandoned')),
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(route,collection_id,generation),
  FOREIGN KEY(route,collection_id) REFERENCES library.collection(route,collection_id)
);
CREATE UNIQUE INDEX canonical_source_working ON library.canonical_source_generation(route,collection_id) WHERE state='working';
CREATE TABLE library.canonical_source_reference (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  canonical_subject_id uuid NOT NULL,
  stored_subject_id uuid NOT NULL,
  driver smallint NOT NULL CHECK(driver BETWEEN 0 AND 5),
  fact_id uuid NOT NULL,
  PRIMARY KEY(route,collection_id,generation,canonical_subject_id,stored_subject_id,driver,fact_id),
  FOREIGN KEY(route,collection_id,generation) REFERENCES library.canonical_source_generation(route,collection_id,generation)
);
CREATE TABLE library.canonical_source_head (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  generation uuid NOT NULL,
  PRIMARY KEY(route,collection_id),
  FOREIGN KEY(route,collection_id,generation) REFERENCES library.canonical_source_generation(route,collection_id,generation)
);
-- No cascade or lease-based disposition. Old public references and capture custody remain retained.
-- migrate:down
-- Forward only: release requires the independent destination-disposition authority.
