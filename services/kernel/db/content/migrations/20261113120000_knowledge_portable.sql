-- migrate:up
ALTER TABLE content.knowledge_revision
  ADD COLUMN reference_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN copy_provenance jsonb;

-- migrate:down
ALTER TABLE content.knowledge_revision
  DROP COLUMN copy_provenance,
  DROP COLUMN reference_manifest;
