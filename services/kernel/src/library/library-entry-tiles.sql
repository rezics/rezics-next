-- Unique PK as a parameterized nested-loop inner so generic prepared plans
-- use entry_pkey. NOT MATERIALIZED inlined the one-row CTE; LATERAL LIMIT 1
-- Seq Scanned because LIMIT 1 lets Seq Scan stop early. Equality filters still
-- Seq Scan when a custom plan inlines the UUID. MATERIALIZED input, Access
-- ROW-bounded primary-key range, and OFFSET 0 keep entry_pkey even when the
-- CTE values are constants. ORDER BY names the primary key with no LIMIT.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
)
SELECT entry."subjectId", entry.state, entry.revision, entry."createdAt", entry."updatedAt",
       entry."incarnationId", entry."lastActivityAt", entry."finishedAt"
FROM input
CROSS JOIN unnest(:subject_ids::uuid[]) AS requested(subject_id)
CROSS JOIN LATERAL (
  SELECT tile.subject_id AS "subjectId", tile.state, tile.revision, tile.created_at::text AS "createdAt",
         tile.updated_at::text AS "updatedAt", tile.incarnation_id AS "incarnationId",
         COALESCE(tile.activity_at, tile.updated_at)::text AS "lastActivityAt",
         tile.finished_at::text AS "finishedAt"
  FROM library.entry AS tile
  WHERE ROW(tile.route, tile.account_id, tile.subject_id)
          >= ROW(input.route, input.account_id, requested.subject_id)
    AND ROW(tile.route, tile.account_id, tile.subject_id)
          <= ROW(input.route, input.account_id, requested.subject_id)
  ORDER BY tile.route, tile.account_id, tile.subject_id
  OFFSET 0
) AS entry;
