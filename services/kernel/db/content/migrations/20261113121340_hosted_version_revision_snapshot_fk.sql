-- migrate:up
-- Descriptor rows name one exact snapshot and that generation's kind. Both producer tables already exist.
ALTER TABLE content.hosted_tree_generation
  ADD CONSTRAINT hosted_tree_generation_identity_kind_key
    UNIQUE (route, catalogue_id, generation_id, generation_kind);

ALTER TABLE content.hosted_version_revision
  ADD CONSTRAINT hosted_version_revision_snapshot_fkey
    FOREIGN KEY (route, catalogue_id, generation_id, sequence)
    REFERENCES content.hosted_tree_snapshot_version (route, catalogue_id, generation_id, sequence),
  ADD CONSTRAINT hosted_version_revision_generation_kind_fkey
    FOREIGN KEY (route, catalogue_id, generation_id, generation_kind)
    REFERENCES content.hosted_tree_generation (route, catalogue_id, generation_id, generation_kind);

-- migrate:down
ALTER TABLE content.hosted_version_revision
  DROP CONSTRAINT hosted_version_revision_generation_kind_fkey,
  DROP CONSTRAINT hosted_version_revision_snapshot_fkey;
ALTER TABLE content.hosted_tree_generation
  DROP CONSTRAINT hosted_tree_generation_identity_kind_key;
