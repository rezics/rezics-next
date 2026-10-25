-- unbound: reconciliation spans every non-empty source partition for one generation
SELECT
  partition.partition_no AS partition,
  partition.position AS head,
  COALESCE(checkpoint.position, 0) AS checkpoint
FROM core.partition AS partition
LEFT JOIN core.consumer_checkpoint AS checkpoint
  ON checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = :consumer
WHERE partition.position > 0
ORDER BY partition.partition_no;
