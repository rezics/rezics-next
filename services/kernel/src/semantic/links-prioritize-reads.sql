INSERT INTO semantic.link_read_demand AS demand (partition_no, expires_at)
SELECT DISTINCT requested.partition_no, statement_timestamp() + interval '2 seconds'
FROM unnest(:partitions::integer[], :epochs::integer[], :positions::bigint[])
  AS requested(partition_no, epoch, position)
JOIN core.partition AS partition ON partition.partition_no = requested.partition_no
LEFT JOIN core.consumer_checkpoint AS checkpoint
  ON checkpoint.partition_no = requested.partition_no AND checkpoint.consumer = :consumer
WHERE requested.position > 0
  AND partition.epoch = requested.epoch AND partition.position >= requested.position
  AND (checkpoint.epoch IS NULL OR (checkpoint.epoch, checkpoint.position) < (requested.epoch, requested.position))
  AND NOT EXISTS (
    SELECT 1 FROM semantic.link_read_demand AS current
    WHERE current.partition_no = requested.partition_no
      AND current.expires_at > statement_timestamp() + interval '1 second'
  )
ORDER BY partition_no
ON CONFLICT (partition_no) DO UPDATE SET expires_at = excluded.expires_at
WHERE demand.expires_at <= statement_timestamp() + interval '1 second';
