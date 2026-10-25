-- unbound: removes one retired search consumer's checkpoints across all partitions
WITH retired AS (
  SELECT partition_no, consumer
  FROM core.consumer_checkpoint
  WHERE consumer = :consumer
  LIMIT 4096
)
DELETE FROM core.consumer_checkpoint AS checkpoint
USING retired
WHERE checkpoint.partition_no = retired.partition_no
  AND checkpoint.consumer = retired.consumer;
