-- migrate:up
-- Canonical storage requires a real seek key on every retained envelope. Existing
-- databases run the explicit bounded prepare/materialization before this migration.
ALTER TABLE rating.source_statistic_head
  ADD COLUMN IF NOT EXISTS last_seek_order bigint NOT NULL DEFAULT 0;
ALTER TABLE rating.source_statistic_head
  ADD CONSTRAINT source_statistic_head_last_seek_order_check CHECK (last_seek_order >= 0);
ALTER TABLE rating.source_statistic_observation
  ADD COLUMN IF NOT EXISTS seek_order bigint NOT NULL;
ALTER TABLE rating.source_statistic_observation
  ALTER COLUMN seek_order SET NOT NULL,
  ADD CONSTRAINT source_statistic_observation_seek_order_check CHECK (seek_order > 0);
CREATE UNIQUE INDEX IF NOT EXISTS source_statistic_observation_seek_order_idx
  ON rating.source_statistic_observation (route, subject_id, source, seek_order DESC);
DROP INDEX IF EXISTS rating.source_statistic_observation_legacy_order_idx;
-- local_order remains nullable: seek_order never establishes historical chronology.

-- migrate:down
-- Forward only: observation provenance and stable traversal keys must survive rollback.
