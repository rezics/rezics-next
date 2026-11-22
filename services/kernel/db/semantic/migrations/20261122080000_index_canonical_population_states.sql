-- migrate:up
-- A home keeps advancing its generation while it awaits announcement or delivery.
-- Index the membership changes so advancing that same pending home can use a HOT update.
DROP INDEX semantic.partition_subjects_canonical_delivery,
  semantic.partition_subjects_canonical_unannounced, semantic.partition_subjects_canonical_frontier;
ALTER TABLE semantic.partition_subjects
  ADD COLUMN canonical_populated boolean GENERATED ALWAYS AS (canonical_count > 0) STORED NOT NULL,
  ADD COLUMN canonical_delivery_pending boolean GENERATED ALWAYS AS
    (canonical_delivered_generation < canonical_generation) STORED NOT NULL,
  ADD COLUMN canonical_announcement_pending boolean GENERATED ALWAYS AS
    (canonical_delivered_generation < canonical_generation AND canonical_announced_generation < canonical_generation) STORED NOT NULL;
CREATE INDEX partition_subjects_canonical_delivery ON semantic.partition_subjects(partition_no)
  WHERE canonical_delivery_pending;
CREATE INDEX partition_subjects_canonical_unannounced ON semantic.partition_subjects(partition_no)
  WHERE canonical_announcement_pending;
CREATE INDEX partition_subjects_canonical_frontier ON semantic.partition_subjects(partition_no)
  WHERE canonical_populated;

-- migrate:down
DROP INDEX semantic.partition_subjects_canonical_delivery,
  semantic.partition_subjects_canonical_unannounced, semantic.partition_subjects_canonical_frontier;
ALTER TABLE semantic.partition_subjects DROP COLUMN canonical_announcement_pending,
  DROP COLUMN canonical_delivery_pending, DROP COLUMN canonical_populated;
CREATE INDEX partition_subjects_canonical_delivery ON semantic.partition_subjects(partition_no)
  WHERE canonical_delivered_generation < canonical_generation;
CREATE INDEX partition_subjects_canonical_unannounced ON semantic.partition_subjects(partition_no)
  WHERE canonical_delivered_generation < canonical_generation AND canonical_announced_generation < canonical_generation;
CREATE INDEX partition_subjects_canonical_frontier ON semantic.partition_subjects(partition_no)
  INCLUDE (canonical_generation) WHERE canonical_count > 0;
