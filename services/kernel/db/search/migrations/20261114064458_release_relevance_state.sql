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

-- migrate:down
DROP TABLE search.release_relevance_execution;
