-- Unique PK as a parameterized nested-loop inner so generic prepared plans
-- use entry_pkey. NOT MATERIALIZED inlined the one-row CTE; LATERAL LIMIT 1
-- Seq Scanned because LIMIT 1 lets Seq Scan stop early. Equality filters still
-- Seq Scan when a custom plan inlines the UUID. Unnest joined directly to
-- LATERAL was decorrelated into a hash join and Seq Scanned a small catalogue
-- (FULL warmup one sequential scan on library.entry). MATERIALIZED keys plus a
-- MATERIALIZED one-row point CTE inside LATERAL keep each seek identical to the
-- unique-key point: Access ROW-bounded primary-key range, OFFSET 0, no LIMIT.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT subject_id FROM unnest(:subject_ids::uuid[]) AS requested(subject_id) ORDER BY subject_id
)
SELECT entry."subjectId", entry.state, entry.revision, entry."createdAt", entry."updatedAt",
       entry."incarnationId", entry."lastActivityAt", entry."finishedAt"
FROM input
CROSS JOIN keys
CROSS JOIN LATERAL (
  WITH point AS MATERIALIZED (
    SELECT input.route, input.account_id, keys.subject_id
  )
  SELECT tile.subject_id AS "subjectId", tile.state, tile.revision, tile.created_at::text AS "createdAt",
         tile.updated_at::text AS "updatedAt", tile.incarnation_id AS "incarnationId",
         COALESCE(tile.activity_at, tile.updated_at)::text AS "lastActivityAt",
         tile.finished_at::text AS "finishedAt"
  FROM point
  CROSS JOIN LATERAL (
    SELECT sought.subject_id, sought.state, sought.revision, sought.created_at, sought.updated_at,
           sought.incarnation_id, sought.activity_at, sought.finished_at
    FROM library.entry AS sought
    WHERE ROW(sought.route, sought.account_id, sought.subject_id)
            >= ROW(point.route, point.account_id, point.subject_id)
      AND ROW(sought.route, sought.account_id, sought.subject_id)
            <= ROW(point.route, point.account_id, point.subject_id)
    ORDER BY sought.route, sought.account_id, sought.subject_id
    OFFSET 0
  ) AS tile
) AS entry;
