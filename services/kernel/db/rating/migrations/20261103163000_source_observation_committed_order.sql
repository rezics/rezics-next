-- migrate:up
ALTER TABLE rating.source_statistic_head
  ADD COLUMN last_order bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT source_statistic_head_last_order_check CHECK (last_order >= 0);

ALTER TABLE rating.source_statistic_observation
  ADD COLUMN payload_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN local_order bigint,
  ADD CONSTRAINT source_statistic_observation_local_order_check
    CHECK (local_order IS NULL OR local_order > 0),
  ADD CONSTRAINT source_statistic_observation_payload_version_check
    CHECK (payload_version > 0);

CREATE UNIQUE INDEX source_statistic_observation_local_order_idx
  ON rating.source_statistic_observation (route, subject_id, source, local_order DESC)
  WHERE local_order IS NOT NULL;

-- migrate:down
-- Forward only: native ordering and payload version metadata are part of retained provenance.
