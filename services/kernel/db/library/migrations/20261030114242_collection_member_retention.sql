ALTER TABLE library.collection_member
  ADD COLUMN member_revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN partition_no integer GENERATED ALWAYS AS (route >> 4) STORED,
  ADD COLUMN deletion_id uuid,
  ADD COLUMN deletion_revision bigint,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN purge_after timestamptz;

ALTER TABLE library.collection_member ALTER COLUMN added_at DROP NOT NULL;

ALTER TABLE library.collection_member
  ADD CONSTRAINT collection_member_retention_check CHECK (
    (deletion_id IS NULL AND deletion_revision IS NULL AND deleted_at IS NULL AND purge_after IS NULL AND added_at IS NOT NULL)
    OR (deletion_id IS NOT NULL AND deletion_revision IS NOT NULL AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND added_at IS NOT NULL)
    OR (deletion_id IS NOT NULL AND deletion_revision IS NULL AND deleted_at IS NULL AND purge_after IS NULL AND added_at IS NULL AND note IS NULL)
  );

ALTER TABLE library.collection_member DROP CONSTRAINT collection_member_ordinal_key;
CREATE UNIQUE INDEX collection_member_live_ordinal ON library.collection_member (route, collection_id, ordinal_key)
  WHERE deletion_id IS NULL;

CREATE UNIQUE INDEX collection_member_deletion_id ON library.collection_member (route, collection_id, deletion_id)
  WHERE deletion_id IS NOT NULL;
CREATE INDEX collection_member_retention_due ON library.collection_member (partition_no, purge_after, route, collection_id, member_id)
  WHERE deletion_id IS NOT NULL AND purge_after IS NOT NULL;
