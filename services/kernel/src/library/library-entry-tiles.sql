-- Unique PK as a parameterized nested-loop inner so generic prepared plans
-- use entry_pkey. NOT MATERIALIZED inlined the one-row CTE; LATERAL LIMIT 1
-- Seq Scanned because LIMIT 1 lets Seq Scan stop early. ROW bounds alone also
-- Seq Scanned under the FULL HTTP capture. Keep the exact-key bounds and add
-- scalar equalities for every PK column so custom and generic plans can seek
-- entry_pkey. Unnest as a sibling
-- MATERIALIZED keys CTE was hash-joined to library.entry (FULL warmup Bitmap
-- Heap Scan / Seq Scan). Drive one integer step from the MATERIALIZED request
-- row that carries the subject-id array, then a MATERIALIZED one-row point CTE
-- inside LATERAL, so each seek is the unique-key point: Access ROW-bounded
-- primary-key range, OFFSET 0, no LIMIT.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :subject_ids::uuid[] AS subject_ids
)
SELECT entry."subjectId", entry.state, entry.revision, entry."createdAt", entry."updatedAt",
       entry."incarnationId", entry."lastActivityAt", entry."finishedAt"
FROM input
CROSS JOIN LATERAL (
  SELECT step.i FROM generate_series(1, cardinality(input.subject_ids)) AS step(i)
) AS step
CROSS JOIN LATERAL (
  WITH point AS MATERIALIZED (
    SELECT input.route, input.account_id, input.subject_ids[step.i] AS subject_id
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
      AND sought.route = point.route
      AND sought.account_id = point.account_id
      AND sought.subject_id = point.subject_id
    ORDER BY sought.route, sought.account_id, sought.subject_id
    OFFSET 0
  ) AS tile
) AS entry;
