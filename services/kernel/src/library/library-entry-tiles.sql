-- Correlated LIMIT-1 primary-key points retain the unique index under generic prepared plans.
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
  WHERE tile.route = input.route AND tile.account_id = input.account_id
    AND tile.subject_id = requested.subject_id
  ORDER BY tile.route, tile.account_id, tile.subject_id
  LIMIT 1
) AS entry;
