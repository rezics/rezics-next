-- migrate:up
ALTER TABLE semantic.partition_subjects
  ADD COLUMN canonical_announced_generation bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT partition_subjects_canonical_announcement_check
    CHECK (canonical_announced_generation BETWEEN 0 AND canonical_generation);
CREATE INDEX partition_subjects_canonical_unannounced ON semantic.partition_subjects(partition_no)
  WHERE canonical_delivered_generation<canonical_generation AND canonical_announced_generation<canonical_generation;

-- migrate:down
DROP INDEX semantic.partition_subjects_canonical_unannounced;
ALTER TABLE semantic.partition_subjects DROP COLUMN canonical_announced_generation;
