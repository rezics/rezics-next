-- unbound: compare committed heads with one consumer across all home ranges.
WITH checkpoints AS MATERIALIZED (
  SELECT shard, positions FROM search.freshness_positions
  WHERE consumer = :consumer::text AND starts_with(:consumer::text, 'search_')
), changed AS MATERIALIZED (
  SELECT h.positions AS heads, c.positions AS checkpoints
  FROM search.freshness_positions h LEFT JOIN checkpoints c USING (shard)
  WHERE h.consumer = '' AND h.positions IS DISTINCT FROM c.positions
), homes AS MATERIALIZED (
  SELECT home.key::integer AS partition_no, home.value::bigint AS head,
    coalesce(CASE WHEN starts_with(:consumer::text, 'search_') THEN (c.checkpoints ->> home.key)::bigint
      ELSE (SELECT p.position FROM core.consumer_checkpoint p
            WHERE p.partition_no = home.key::integer AND p.consumer = :consumer::text LIMIT 1)
    END, 0) AS checkpoint
  FROM changed c CROSS JOIN LATERAL jsonb_each_text(c.heads) home
)
SELECT statement_timestamp() AS now, count(*)::integer AS behind,
  min((SELECT o.recorded_at FROM core.outbox o
       WHERE o.partition_no = h.partition_no AND o.position = h.checkpoint + 1 AND o.event_seq = 0 LIMIT 1)) AS oldest
FROM homes h WHERE h.head > h.checkpoint;
