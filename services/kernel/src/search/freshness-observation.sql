WITH input AS MATERIALIZED (
  SELECT :consumer::text AS consumer, pg_current_snapshot() AS current,
         revision, CASE WHEN revision::text = :revision::text THEN nullif(:snapshot::text, '')::pg_snapshot END AS prior
  FROM search.freshness_observation_reset WHERE singleton
),
-- Only top-level transactions still running at the previous cut, or assigned after it,
-- could have committed a new point. Each such row already carries one side of the comparison.
deltas AS (
  SELECT p.consumer, p.shard AS home, (p.positions->>p.shard::text)::bigint AS position
  FROM input i CROSS JOIN search.freshness_positions p
  WHERE p.consumer IN ('', i.consumer) AND p.change_xid >= pg_snapshot_xmax(i.prior)
  UNION ALL
  SELECT stream.name, p.shard, (p.positions->>p.shard::text)::bigint FROM input i
  CROSS JOIN LATERAL pg_snapshot_xip(i.prior) AS active(xid)
  CROSS JOIN LATERAL (VALUES (''::text), (i.consumer)) AS stream(name)
  CROSS JOIN LATERAL (
    SELECT shard, positions FROM search.freshness_positions
    -- Keep the seek narrow even when many checkpoint rows share one bulk transaction ID.
    WHERE consumer = stream.name AND change_xid >= active.xid AND change_xid <= active.xid
    OFFSET 0
  ) p
), changed AS MATERIALIZED (
  SELECT home, max(position) FILTER (WHERE consumer = '') AS head,
         max(position) FILTER (WHERE consumer <> '') AS checkpoint
  FROM deltas GROUP BY home
), points AS (
  SELECT c.home,
    coalesce(c.head, (SELECT (p.positions->>p.shard::text)::bigint FROM search.freshness_positions p
                       WHERE p.consumer = '' AND p.shard = c.home), 0) AS head,
    coalesce(c.checkpoint, (SELECT (p.positions->>p.shard::text)::bigint FROM search.freshness_positions p
                             WHERE p.consumer = i.consumer AND p.shard = c.home), 0) AS checkpoint
  FROM changed c CROSS JOIN input i
  UNION ALL
  SELECT h.shard, coalesce((h.positions->>h.shard::text)::bigint, 0),
         coalesce((k.positions->>h.shard::text)::bigint, 0)
  FROM input i JOIN search.freshness_positions h ON h.consumer = ''
  LEFT JOIN search.freshness_positions k ON k.shard = h.shard AND k.consumer = i.consumer
  WHERE i.prior IS NULL
), homes AS (
  SELECT home, checkpoint, head > checkpoint AS behind FROM points OFFSET 0
)
SELECT statement_timestamp() AS now, i.current::text AS snapshot, i.revision::text AS revision,
       i.prior IS NULL AS complete, coalesce((
         SELECT jsonb_agg(jsonb_build_array(h.home, h.behind, CASE WHEN h.behind THEN (
           SELECT o.recorded_at FROM core.outbox o
           WHERE o.partition_no = h.home AND o.position = h.checkpoint+1 AND o.event_seq=0
         ) END)) FROM homes h WHERE h.behind OR i.prior IS NOT NULL
       ), '[]'::jsonb) AS homes FROM input i;
