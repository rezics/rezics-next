-- migrate:up
-- Membership belongs to the immutable selected revision, independently of media processing.
ALTER TABLE content.knowledge_revision
  ADD COLUMN media_ids uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT knowledge_revision_media_ids_check CHECK (
    cardinality(media_ids) <= 32 AND array_position(media_ids, NULL) IS NULL
  );

-- migrate:down
-- Forward only: retained revisions keep their exact managed-media membership.
