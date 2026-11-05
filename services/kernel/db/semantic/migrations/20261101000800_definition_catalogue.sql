-- migrate:up
-- All catalogue configuration belongs to Global. Bodies and completed indexes are immutable.
CREATE TABLE semantic.definition_catalogue_artifact (
  route integer NOT NULL CHECK (route = 0),
  digest text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('root','node','release','declaration')),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 4194304),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, digest)
);
CREATE TABLE semantic.definition_catalogue_build (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  pin jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('building','incomplete','refused','ready')),
  phase text NOT NULL DEFAULT 'node' CHECK (phase IN ('node','release','declaration')),
  next_node bigint,
  steps bigint NOT NULL DEFAULT 0,
  nodes bigint NOT NULL DEFAULT 0,
  releases bigint NOT NULL DEFAULT 0,
  declarations bigint NOT NULL DEFAULT 0,
  indexed_rows bigint NOT NULL DEFAULT 0,
  examined_bytes bigint NOT NULL DEFAULT 0,
  missing_digest text,
  error text,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, root_digest)
);
CREATE TABLE semantic.definition_catalogue_task (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  task_id bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('node','release','declaration')),
  digest text NOT NULL,
  entry_key bytea,
  first_key bytea,
  last_key bytea,
  next_node bigint,
  offset_rows integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, root_digest, task_id),
  FOREIGN KEY (route, root_digest) REFERENCES semantic.definition_catalogue_build(route,root_digest)
);
CREATE UNIQUE INDEX definition_catalogue_node_once ON semantic.definition_catalogue_task(route,root_digest,digest) WHERE kind='node';
CREATE INDEX definition_catalogue_pending ON semantic.definition_catalogue_task(route,root_digest,kind,task_id) WHERE NOT done;
CREATE TABLE semantic.definition_catalogue_identity (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  identity_key text NOT NULL,
  identity bytea NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY (route,root_digest,identity_key)
);
CREATE TABLE semantic.definition_catalogue_member (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  release_digest text NOT NULL,
  category text NOT NULL CHECK (category IN ('type','property','profile')),
  id_key text NOT NULL,
  id bytea NOT NULL,
  body json NOT NULL,
  PRIMARY KEY (route,root_digest,release_digest,category,id_key)
);
CREATE TABLE semantic.definition_catalogue_kind (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  id_key text NOT NULL,
  id bytea NOT NULL,
  ordinal bigint NOT NULL,
  declaration_digest text NOT NULL,
  body json NOT NULL,
  exact_type_key text NOT NULL,
  exact_type_id bytea NOT NULL,
  precedence integer NOT NULL,
  eligible boolean NOT NULL,
  PRIMARY KEY (route,root_digest,id_key),
  UNIQUE (route,root_digest,ordinal)
);
CREATE INDEX definition_catalogue_candidates ON semantic.definition_catalogue_kind(route,root_digest,exact_type_key,precedence DESC,ordinal) WHERE eligible;
CREATE TABLE semantic.definition_catalogue_label (
  route integer NOT NULL CHECK (route = 0),
  root_digest text NOT NULL,
  language_key text NOT NULL,
  language text NOT NULL,
  label_sort bytea NOT NULL,
  ordinal bigint NOT NULL,
  id_key text NOT NULL,
  PRIMARY KEY (route,root_digest,language_key,label_sort,ordinal),
  FOREIGN KEY (route,root_digest,ordinal) REFERENCES semantic.definition_catalogue_kind(route,root_digest,ordinal)
);
CREATE UNIQUE INDEX definition_catalogue_label_boundary ON semantic.definition_catalogue_label(route,root_digest,language_key,ordinal) INCLUDE(label_sort);
CREATE TABLE semantic.definition_catalogue_head (
  route integer PRIMARY KEY CHECK (route = 0),
  root_digest text,
  head integer NOT NULL DEFAULT 0 CHECK (head >= 0),
  recorded_transaction_id uuid
);
INSERT INTO semantic.definition_catalogue_head(route) VALUES (0);

-- migrate:down
DROP TABLE semantic.definition_catalogue_head;
DROP TABLE semantic.definition_catalogue_label;
DROP TABLE semantic.definition_catalogue_kind;
DROP TABLE semantic.definition_catalogue_member;
DROP TABLE semantic.definition_catalogue_identity;
DROP TABLE semantic.definition_catalogue_task;
DROP TABLE semantic.definition_catalogue_build;
DROP TABLE semantic.definition_catalogue_artifact;
