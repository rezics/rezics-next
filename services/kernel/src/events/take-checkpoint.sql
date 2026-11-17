WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no, :consumer::text AS consumer
), locked AS (
  SELECT checkpoint.epoch, checkpoint.position
  FROM core.consumer_checkpoint AS checkpoint, input
  WHERE checkpoint.partition_no = input.partition_no AND checkpoint.consumer = input.consumer
  FOR UPDATE OF checkpoint SKIP LOCKED
), created AS (
  INSERT INTO core.consumer_checkpoint (partition_no, consumer)
  SELECT input.partition_no, input.consumer FROM input
  WHERE NOT EXISTS (SELECT 1 FROM locked)
  ON CONFLICT (partition_no, consumer) DO NOTHING
  RETURNING epoch, position
)
SELECT epoch, position FROM locked
UNION ALL
SELECT epoch, position FROM created
LIMIT 1;
