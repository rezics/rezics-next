-- migrate:up
-- Record the seed at installation, while the home counter is locked. A native
-- generation, announcement, acknowledgement or Rating cursor is never rewritten.
ALTER TABLE semantic.partition_subjects ADD COLUMN canonical_empty_seed boolean NOT NULL DEFAULT true;
-- Future rows may be born directly from a Subject or identity mutation at generation one.
ALTER TABLE semantic.partition_subjects ALTER COLUMN canonical_empty_seed SET DEFAULT false;
UPDATE semantic.partition_subjects s SET canonical_empty_seed=false
WHERE s.canonical_generation<>1 OR s.canonical_count<>0 OR s.visible<>0
  OR s.canonical_announced_generation<>0 OR s.canonical_delivered_generation<>0
  OR NOT EXISTS (SELECT FROM core.partition p WHERE p.partition_no=s.partition_no
                 AND p.epoch=1 AND p.position=0 AND p.write_state='active')
  OR EXISTS (SELECT FROM rating.realm_rank r WHERE r.partition_no=s.partition_no)
  OR EXISTS (SELECT FROM rating.realm_rank_generation g WHERE g.partition_no=s.partition_no)
  OR EXISTS (SELECT FROM rating.realm_rank_canonical_state c WHERE c.partition_no=s.partition_no);

-- An older sender may still announce the seed during rollout. Recover that
-- notification too. Later generations stay due even after the last Subject goes.
CREATE VIEW semantic.pending_canonical_generation AS
SELECT partition_no,canonical_generation,canonical_announced_generation FROM semantic.partition_subjects
WHERE canonical_delivered_generation<canonical_generation
  AND (NOT canonical_empty_seed OR canonical_generation>1 OR canonical_announced_generation>0);

DROP INDEX semantic.partition_subjects_canonical_delivery;
DROP INDEX semantic.partition_subjects_canonical_unannounced;
CREATE INDEX partition_subjects_canonical_delivery ON semantic.partition_subjects(partition_no)
  WHERE canonical_delivered_generation<canonical_generation
    AND (NOT canonical_empty_seed OR canonical_generation>1 OR canonical_announced_generation>0);
CREATE INDEX partition_subjects_canonical_unannounced ON semantic.partition_subjects(partition_no)
  WHERE canonical_delivered_generation<canonical_generation AND canonical_announced_generation<canonical_generation
    AND (NOT canonical_empty_seed OR canonical_generation>1 OR canonical_announced_generation>0);

-- migrate:down
DROP VIEW semantic.pending_canonical_generation;
DROP INDEX semantic.partition_subjects_canonical_delivery;
DROP INDEX semantic.partition_subjects_canonical_unannounced;
ALTER TABLE semantic.partition_subjects DROP COLUMN canonical_empty_seed;
CREATE INDEX partition_subjects_canonical_delivery ON semantic.partition_subjects(partition_no)
  WHERE canonical_delivered_generation<canonical_generation;
CREATE INDEX partition_subjects_canonical_unannounced ON semantic.partition_subjects(partition_no)
  WHERE canonical_delivered_generation<canonical_generation AND canonical_announced_generation<canonical_generation;
