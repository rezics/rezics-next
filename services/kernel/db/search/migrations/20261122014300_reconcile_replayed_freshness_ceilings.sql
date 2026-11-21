-- migrate:up
LOCK TABLE core.partition, core.consumer_checkpoint IN SHARE ROW EXCLUSIVE MODE;

-- Replica replay can deliver a checkpoint before its home. Recover that ceiling
-- even if the home arrived after the original cutover and has since advanced.
-- Group the native checkpoints once and touch only missing or lower home bounds.
WITH ceilings AS (
  SELECT partition_no, max(position) AS ceiling
  FROM core.consumer_checkpoint WHERE position > 0 GROUP BY partition_no
)
INSERT INTO search.freshness_home AS h(partition_no, head, checkpoint_ceiling)
SELECT c.partition_no, coalesce(p.position, 0), c.ceiling
FROM ceilings c LEFT JOIN core.partition p USING (partition_no)
LEFT JOIN search.freshness_home old ON old.partition_no = c.partition_no
WHERE old.checkpoint_ceiling IS NULL OR old.checkpoint_ceiling < c.ceiling
ON CONFLICT (partition_no) DO UPDATE SET checkpoint_ceiling = EXCLUDED.checkpoint_ceiling
  WHERE h.checkpoint_ceiling < EXCLUDED.checkpoint_ceiling;

-- migrate:down
-- The prior layout accepts these native high-water values without a schema change.
SELECT 1;
