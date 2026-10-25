-- unbound: the search index watermark spans every partition
SELECT
  statement_timestamp() AS now,
  count(*) FILTER (WHERE partition.position > COALESCE(checkpoint.position, 0))::integer AS behind,
  min(CASE WHEN partition.position > COALESCE(checkpoint.position, 0) THEN (
    SELECT outbox.recorded_at
    FROM core.outbox AS outbox
    WHERE outbox.partition_no = partition.partition_no
      AND outbox.position = COALESCE(checkpoint.position, 0) + 1
      AND outbox.event_seq = 0
    LIMIT 1
  ) END) AS oldest
FROM core.partition AS partition
LEFT JOIN core.consumer_checkpoint AS checkpoint
  ON checkpoint.partition_no = partition.partition_no AND checkpoint.consumer = :consumer;
