-- migrate:up
ALTER TABLE library.collection
  ADD COLUMN partition_no integer GENERATED ALWAYS AS (route >> 4) STORED;

CREATE INDEX collection_retention_due ON library.collection
  (partition_no, purge_after, route, collection_id)
  WHERE state = 'deleted' AND purge_after IS NOT NULL;

-- migrate:down
-- Forward only: preserve the bounded due frontier.
