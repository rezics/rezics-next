-- Correlated LIMIT-1 primary-key points retain the unique index under generic prepared plans.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
)
SELECT entry."subjectId", entry.state, entry.revision, entry."createdAt", entry."updatedAt",
       entry."incarnationId", entry."lastActivityAt", entry."finishedAt"
FROM input
CROSS JOIN unnest(:subject_ids::uuid[]) AS requested(subject_id)
CROSS JOIN LATERAL (
  SELECT subject_id AS "subjectId", state, revision, created_at::text AS "createdAt",
         updated_at::text AS "updatedAt", incarnation_id AS "incarnationId",
         COALESCE(activity_at, updated_at)::text AS "lastActivityAt", finished_at::text AS "finishedAt"
  FROM library.entry
  WHERE route = input.route AND account_id = input.account_id AND subject_id = requested.subject_id
  ORDER BY subject_id
  LIMIT 1
) AS entry;
