ALTER TABLE content.projection_checkpoint
  ADD COLUMN pending_count bigint NOT NULL DEFAULT 0;
ALTER TABLE content.projection_checkpoint
  ADD CONSTRAINT projection_checkpoint_pending_count_nonnegative CHECK (pending_count >= 0);

UPDATE content.projection_checkpoint c
SET pending_count = (
  SELECT count(*) FROM content.projection_pending p
  WHERE p.consumer = c.consumer AND p.data_epoch = c.data_epoch
);
