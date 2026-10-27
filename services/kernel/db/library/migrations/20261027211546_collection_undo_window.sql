-- migrate:up
ALTER TABLE library.collection
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN purge_after timestamptz,
  ADD CONSTRAINT collection_deletion_pair CHECK ((deleted_at IS NULL) = (purge_after IS NULL)),
  ADD CONSTRAINT collection_deletion_window CHECK (purge_after = deleted_at + interval '720 hours'),
  ADD CONSTRAINT collection_active_deletion CHECK (state <> 'active' OR deleted_at IS NULL);

CREATE INDEX collection_deletion_due ON library.collection (route, purge_after, collection_id)
  WHERE state = 'deleted' AND purge_after IS NOT NULL;
CREATE INDEX collection_deletion_pending_legacy ON library.collection (route, collection_id)
  WHERE state = 'deleted' AND deleted_at IS NULL;

-- migrate:down
-- Forward only: recorded deletion windows must survive rollback.
