-- migrate:up
-- Ordered staging pins the same immutable Book revision/generation/sequence that its readers consume.
ALTER TABLE content.hosted_version_revision
  ADD CONSTRAINT hosted_version_revision_exact_source_key
    UNIQUE (route, catalogue_id, revision_id, generation_id, sequence);

ALTER TABLE content.hosted_publication_staging
  ADD COLUMN source_kind text NOT NULL DEFAULT 'snapshot',
  ADD COLUMN source_ordered_generation_id uuid,
  ADD COLUMN source_ordered_sequence bigint;

UPDATE content.hosted_publication_staging
SET source_kind = CASE WHEN source_has_descriptor THEN 'prefix' ELSE 'snapshot' END;

ALTER TABLE content.hosted_publication_staging
  ALTER COLUMN source_kind DROP DEFAULT,
  ADD CONSTRAINT hosted_publication_staging_source_kind_check
    CHECK (source_kind IN ('snapshot', 'prefix', 'ordered')),
  ADD CONSTRAINT hosted_publication_staging_ordered_source_shape_check
    CHECK (
      (source_kind = 'ordered' AND NOT source_has_descriptor
        AND source_ordered_generation_id IS NOT NULL AND source_ordered_sequence IS NOT NULL
        AND source_ordered_sequence >= 0)
      OR
      (source_kind = 'prefix' AND source_has_descriptor
        AND source_ordered_generation_id IS NULL AND source_ordered_sequence IS NULL)
      OR
      (source_kind = 'snapshot' AND NOT source_has_descriptor
        AND source_ordered_generation_id IS NULL AND source_ordered_sequence IS NULL)
    ),
  ADD CONSTRAINT hosted_publication_staging_ordered_generation_route_check
    CHECK (source_ordered_generation_id IS NULL OR
      route = get_byte(uuid_send(source_ordered_generation_id), 10) * 256
        + get_byte(uuid_send(source_ordered_generation_id), 11)),
  ADD CONSTRAINT hosted_publication_staging_ordered_source_fkey
    FOREIGN KEY (route, catalogue_id, source_revision_id, source_ordered_generation_id, source_ordered_sequence)
    REFERENCES content.hosted_version_revision (route, catalogue_id, revision_id, generation_id, sequence);

-- migrate:down
ALTER TABLE content.hosted_publication_staging
  DROP CONSTRAINT hosted_publication_staging_ordered_source_fkey,
  DROP CONSTRAINT hosted_publication_staging_ordered_generation_route_check,
  DROP CONSTRAINT hosted_publication_staging_ordered_source_shape_check,
  DROP CONSTRAINT hosted_publication_staging_source_kind_check,
  DROP COLUMN source_ordered_sequence,
  DROP COLUMN source_ordered_generation_id,
  DROP COLUMN source_kind;

ALTER TABLE content.hosted_version_revision
  DROP CONSTRAINT hosted_version_revision_exact_source_key;
