-- unbound: at most one indexed admission wake per home in the fixed partition map
SELECT partition.partition_no, wake.position
FROM core.partition AS partition
LEFT JOIN core.consumer_checkpoint AS checkpoint
  ON checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = :consumer
JOIN LATERAL (
  SELECT outbox.position, outbox.recorded_at
  FROM core.outbox AS outbox
  WHERE outbox.partition_no = partition.partition_no
    AND outbox.position > COALESCE(checkpoint.position, 0)
    AND outbox.position <= partition.position
    AND outbox.type = 'com.rezics.semantic.identity-epoch.admitted.v1'
    AND outbox.payload_state = 'present'
  ORDER BY outbox.position
  LIMIT 1
) AS wake ON true
WHERE partition.position > COALESCE(checkpoint.position, 0)
ORDER BY wake.recorded_at, partition.partition_no;
