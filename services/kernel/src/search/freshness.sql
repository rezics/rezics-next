-- unbound: seek the homes behind one consumer, then its first retained envelopes.
WITH input AS NOT MATERIALIZED (
  SELECT :consumer::text AS consumer
), candidates AS (
  SELECT partition_no FROM search.freshness_home WHERE head > 0 AND checkpoints = '{}'
  UNION ALL
  SELECT g.partition_no FROM search.freshness_gap g, input i
  WHERE g.consumers @> (i.consumer COLLATE "C")
), homes AS MATERIALIZED (
  SELECT h.partition_no, coalesce((SELECT c.position FROM core.consumer_checkpoint c
                                   WHERE c.partition_no = h.partition_no AND c.consumer = i.consumer LIMIT 1), 0) AS checkpoint
  FROM candidates h CROSS JOIN input i
)
SELECT statement_timestamp() AS now, count(*)::integer AS behind,
  min((SELECT o.recorded_at FROM core.outbox o
       WHERE o.partition_no = h.partition_no AND o.position = h.checkpoint + 1 AND o.event_seq = 0 LIMIT 1)) AS oldest
FROM homes h CROSS JOIN input i
WHERE starts_with(i.consumer, 'search_') OR
  (SELECT p.position FROM core.partition p WHERE p.partition_no = h.partition_no LIMIT 1) > h.checkpoint;
