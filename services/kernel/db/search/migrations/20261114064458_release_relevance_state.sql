-- migrate:up
-- Private, viewer-bound lineage for exact relevance-work duplicate suppression.
CREATE TABLE search.release_relevance_execution (
  id uuid PRIMARY KEY,
  principal text NOT NULL CHECK (octet_length(principal) <= 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL CHECK (generation > 0),
  source_cut_hash text NOT NULL CHECK (source_cut_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX release_relevance_execution_expiry
  ON search.release_relevance_execution (expires_at, id);

CREATE TABLE search.release_relevance_position (
  execution_id uuid NOT NULL REFERENCES search.release_relevance_execution ON DELETE CASCADE,
  id uuid NOT NULL,
  parent_id uuid,
  branch_hash text NOT NULL CHECK (branch_hash ~ '^[0-9a-f]{64}$'),
  work_digest text NOT NULL CHECK (work_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (execution_id, id)
);
CREATE UNIQUE INDEX release_relevance_position_branch
  ON search.release_relevance_position (execution_id, parent_id, branch_hash)
  WHERE parent_id IS NOT NULL;

CREATE TABLE search.release_relevance_work (
  execution_id uuid NOT NULL,
  position_id uuid NOT NULL,
  work_id text COLLATE "C" NOT NULL CHECK (work_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  PRIMARY KEY (execution_id, position_id, work_id),
  FOREIGN KEY (execution_id, position_id)
    REFERENCES search.release_relevance_position (execution_id, id) ON DELETE CASCADE
);

-- migrate:down
DROP TABLE search.release_relevance_work;
DROP TABLE search.release_relevance_position;
DROP TABLE search.release_relevance_execution;
