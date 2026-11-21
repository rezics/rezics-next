WITH input AS MATERIALIZED (
  SELECT :consumer::text AS consumer, pg_current_snapshot() AS current,
         revision, CASE WHEN revision::text = :revision::text THEN nullif(:snapshot::text, '')::pg_snapshot END AS prior
  FROM search.freshness_observation_reset WHERE singleton
), changed AS MATERIALIZED (
  SELECT DISTINCT p.shard AS home
  FROM input i CROSS JOIN search.freshness_positions p
  WHERE p.consumer IN ('', i.consumer) AND p.change_xid >= pg_snapshot_xmin(i.prior)
    AND NOT pg_visible_in_snapshot(p.change_xid, i.prior)
), points AS (
  SELECT c.home, h.positions AS head, k.positions AS checkpoint FROM changed c CROSS JOIN input i
  LEFT JOIN LATERAL (SELECT positions FROM search.freshness_positions
    WHERE consumer = '' AND shard = c.home OFFSET 0) h ON true
  LEFT JOIN LATERAL (SELECT positions FROM search.freshness_positions
    WHERE consumer = i.consumer AND shard = c.home OFFSET 0) k ON true
  UNION ALL
  SELECT h.shard, h.positions, k.positions FROM input i JOIN search.freshness_positions h ON h.consumer = ''
  LEFT JOIN search.freshness_positions k ON k.shard = h.shard AND k.consumer = i.consumer
  WHERE i.prior IS NULL
), homes AS (
  SELECT home, coalesce((checkpoint->>home::text)::bigint, 0) AS checkpoint,
         coalesce((head->>home::text)::bigint, 0) > coalesce((checkpoint->>home::text)::bigint, 0) AS behind FROM points
)
SELECT statement_timestamp() AS now, i.current::text AS snapshot, i.revision::text AS revision,
       i.prior IS NULL AS complete, coalesce((
         SELECT jsonb_agg(jsonb_build_array(h.home, h.behind, CASE WHEN h.behind THEN (
           SELECT o.recorded_at FROM core.outbox o
           WHERE o.partition_no = h.home AND o.position = h.checkpoint+1 AND o.event_seq=0
         ) END)) FROM homes h WHERE h.behind OR i.prior IS NOT NULL
       ), '[]'::jsonb) AS homes FROM input i;
