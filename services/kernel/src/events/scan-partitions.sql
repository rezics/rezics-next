-- unbound: scans the fixed 4096-partition map to find relay work
SELECT partition.partition_no
FROM core.partition AS partition
LEFT JOIN core.consumer_checkpoint AS checkpoint
  ON checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = :consumer
WHERE partition.position > COALESCE(checkpoint.position, 0)
ORDER BY partition.partition_no;
