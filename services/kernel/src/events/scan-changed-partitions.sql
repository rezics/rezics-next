-- Recheck each changed head and each previously pending home in the original discovery snapshot.
SELECT partition.partition_no, partition.position, min(pending.recorded_at) OVER () AS oldest_pending_at
FROM unnest(:homes::integer[]) AS wanted(home)
JOIN LATERAL (
  SELECT p.partition_no, p.position FROM core.partition p WHERE p.partition_no = wanted.home LIMIT 1
) AS partition ON true
LEFT JOIN LATERAL (
  SELECT c.position FROM core.consumer_checkpoint c
  WHERE c.partition_no = wanted.home AND c.consumer = :consumer::text LIMIT 1
) AS checkpoint ON true
LEFT JOIN core.outbox AS pending
  ON pending.partition_no = wanted.home AND pending.position = COALESCE(checkpoint.position, 0) + 1
  AND pending.event_seq = 0
WHERE partition.position > COALESCE(checkpoint.position, 0)
ORDER BY pending.recorded_at ASC NULLS FIRST, partition.partition_no;
