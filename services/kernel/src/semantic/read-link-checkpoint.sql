-- The full display may add its Subject anchor to a session that already contains that home.
-- Compare both requirements against the same checkpoint snapshot.
SELECT seen.partition_no, seen.epoch, seen.position,
       checkpoint.epoch AS checkpoint_epoch, checkpoint.position AS checkpoint_position
FROM unnest(:partitions::integer[], :epochs::integer[], :positions::bigint[])
     WITH ORDINALITY AS seen(partition_no, epoch, position, ordinal)
LEFT JOIN LATERAL (
  SELECT c.epoch, c.position FROM core.consumer_checkpoint AS c
  WHERE c.partition_no = seen.partition_no AND c.consumer = :consumer::text
  LIMIT 1
) AS checkpoint ON true
WHERE checkpoint.epoch IS NULL OR (checkpoint.epoch, checkpoint.position) < (seen.epoch, seen.position)
ORDER BY seen.ordinal
LIMIT 1;
