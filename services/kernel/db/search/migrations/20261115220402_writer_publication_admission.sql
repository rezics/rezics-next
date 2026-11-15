-- migrate:up
-- A tuple to detect stale Serializable snapshots across the target's advisory lock.
-- Publication state and the drain frontier remain in identity_writer_gate.
CREATE TABLE search.generation_publication_lock (
  physical_target text COLLATE "C" PRIMARY KEY CHECK (octet_length(physical_target) BETWEEN 1 AND 255),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE INDEX identity_writer_target_frontier ON search.identity_writer (physical_target,partition_no);

-- migrate:down
DROP INDEX search.identity_writer_target_frontier;
DROP TABLE search.generation_publication_lock;
