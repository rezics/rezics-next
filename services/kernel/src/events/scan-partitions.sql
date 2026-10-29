-- unbound: scans the fixed 4096-partition map to find relay work, oldest pending envelope first
SELECT partition.partition_no, min(pending.recorded_at) OVER () AS oldest_pending_at
FROM core.partition AS partition
LEFT JOIN core.consumer_checkpoint AS checkpoint
  ON checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = :consumer
LEFT JOIN LATERAL (
  SELECT outbox.recorded_at
  FROM core.outbox AS outbox
  WHERE outbox.partition_no = partition.partition_no
    AND outbox.position = COALESCE(checkpoint.position, 0) + 1
    AND outbox.event_seq = 0
) AS pending ON true
WHERE partition.position > COALESCE(checkpoint.position, 0)
ORDER BY pending.recorded_at ASC NULLS FIRST, partition.partition_no;
