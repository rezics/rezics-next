-- unbound: compare committed outbox heads with the named consumer in one snapshot.
WITH input AS NOT MATERIALIZED (
  SELECT :consumer::text AS consumer
), generation AS MATERIALIZED (
  SELECT consumer FROM input WHERE starts_with(consumer, 'search_')
), checkpoints AS MATERIALIZED (
  SELECT g.shard, g.positions FROM search.freshness_groups g JOIN generation ON g.consumer = generation.consumer
), pending AS MATERIALIZED (
  SELECT p.shard AS home, (p.positions ->> p.shard::text)::bigint AS head
  FROM generation CROSS JOIN search.freshness_positions p WHERE p.consumer = '' AND p.pending
), changed AS MATERIALIZED (
  SELECT g.positions AS heads, c.positions AS checkpoints
  FROM generation CROSS JOIN search.freshness_groups g LEFT JOIN checkpoints c USING (shard)
  WHERE g.consumer = '' AND g.positions IS DISTINCT FROM c.positions
), homes AS (
  -- A pending point replaces its stored head, including when the newer point is absent.
  SELECT h.key::integer AS home, h.value::bigint AS head,
         coalesce((g.checkpoints ->> h.key)::bigint, 0) AS checkpoint
  FROM changed g CROSS JOIN LATERAL jsonb_each_text(g.heads) h
  WHERE NOT EXISTS (SELECT 1 FROM pending p WHERE p.home = h.key::integer)
  UNION ALL
  SELECT p.home, p.head, coalesce((c.positions ->> p.home::text)::bigint, 0)
  FROM pending p LEFT JOIN checkpoints c ON c.shard = p.home / 64
), behind AS MATERIALIZED (
  SELECT home, checkpoint FROM homes WHERE head > checkpoint
  UNION ALL
  -- Other consumers have no checkpoint groups. Compare their native positions directly.
  SELECT h.partition_no, coalesce(c.position, 0)
  FROM input i CROSS JOIN core.partition h
  LEFT JOIN core.consumer_checkpoint c ON c.partition_no = h.partition_no AND c.consumer = i.consumer
  WHERE NOT starts_with(i.consumer, 'search_') AND h.position > coalesce(c.position, 0)
)
SELECT statement_timestamp() AS now, count(*)::integer AS behind,
       min((SELECT o.recorded_at FROM core.outbox o
            WHERE o.partition_no = b.home AND o.position = b.checkpoint + 1 AND o.event_seq = 0 LIMIT 1)) AS oldest
FROM behind b;
