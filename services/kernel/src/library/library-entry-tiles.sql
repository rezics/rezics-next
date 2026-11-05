SELECT entry."subjectId", entry.state, entry.revision, entry."createdAt", entry."updatedAt",
       entry."incarnationId", entry."lastActivityAt", entry."finishedAt"
FROM unnest(:subject_ids::uuid[]) AS requested(subject_id)
CROSS JOIN LATERAL (
  SELECT subject_id AS "subjectId", state, revision, created_at::text AS "createdAt",
         updated_at::text AS "updatedAt", incarnation_id AS "incarnationId",
         COALESCE(activity_at, updated_at)::text AS "lastActivityAt", finished_at::text AS "finishedAt"
  FROM library.entry
  WHERE route = :route AND account_id = :account_id AND subject_id = requested.subject_id
  LIMIT 1
) AS entry;
