-- migrate:up
-- Derived membership and pending native edge cursors share the owning scope plan's
-- revision, worker lease and expiry. Retirement disables reads before bounded deletion.
CREATE TABLE search.scope_preparation_concept_member (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  prefix text COLLATE "C" NOT NULL,
  scope_id text COLLATE "C" NOT NULL,
  concept text COLLATE "C" NOT NULL CHECK (octet_length(concept) BETWEEN 1 AND 1024),
  PRIMARY KEY (partition_no,prefix,scope_id,concept)
);
CREATE TABLE search.scope_preparation_concept_frontier (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  prefix text COLLATE "C" NOT NULL,
  scope_id text COLLATE "C" NOT NULL,
  parent text COLLATE "C" NOT NULL CHECK (octet_length(parent) BETWEEN 1 AND 1024),
  after_key text COLLATE "C" CHECK (octet_length(after_key) BETWEEN 1 AND 1024),
  PRIMARY KEY (partition_no,prefix,scope_id,parent)
);
CREATE INDEX scope_preparation_concept_expiry ON search.scope_preparation
  (partition_no,prefix,expires_at,scope_id)
  WHERE definition->>'kind'='concept' AND state IN ('capture','ready');
CREATE INDEX scope_preparation_concept_retired ON search.scope_preparation
  (partition_no,prefix,scope_id) WHERE definition->>'kind'='concept' AND state='retained'
    AND frontier->>'cleaned' IS DISTINCT FROM 'true';

-- migrate:down
DROP INDEX search.scope_preparation_concept_retired;
DROP INDEX search.scope_preparation_concept_expiry;
DROP TABLE search.scope_preparation_concept_frontier;
DROP TABLE search.scope_preparation_concept_member;
