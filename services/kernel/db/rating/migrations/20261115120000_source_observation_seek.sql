-- migrate:up
-- Stage one only: retained development slots are materialized explicitly in bounded
-- subject/provider transactions before their reads/writes resume. No history backfill runs here.
ALTER TABLE rating.source_statistic_head
  ADD COLUMN last_seek_order bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT source_statistic_head_last_seek_order_check CHECK (last_seek_order >= 0);
ALTER TABLE rating.source_statistic_observation
  ADD COLUMN seek_order bigint,
  ADD CONSTRAINT source_statistic_observation_seek_order_check CHECK (seek_order > 0),
  ADD CONSTRAINT source_statistic_observation_seek_order_present CHECK (seek_order IS NOT NULL) NOT VALID;
CREATE UNIQUE INDEX source_statistic_observation_seek_order_idx
  ON rating.source_statistic_observation (route, subject_id, source, seek_order DESC);
CREATE INDEX source_statistic_observation_unkeyed_idx
  ON rating.source_statistic_observation (route, subject_id, source) WHERE seek_order IS NULL;
DROP INDEX rating.source_statistic_observation_legacy_order_idx;
-- After bounded materialization and readback of retained slots, maintenance may
-- VALIDATE CONSTRAINT source_statistic_observation_seek_order_present and SET NOT NULL.
-- local_order remains nullable: seek_order never establishes historical chronology.

-- migrate:down
-- Forward only: observation provenance and stable traversal keys must survive rollback.
