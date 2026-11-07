-- Correlated LIMIT-1 primary-key points retain the unique index under generic prepared plans.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id,
         :include_deleted::boolean AS include_deleted
)
SELECT point.id, point.name, point.revision, point."createdAt", point."updatedAt",
       point."deletedAt", point."purgeAfter"
FROM input
CROSS JOIN LATERAL (
  SELECT label_id AS id, normalized_name AS name, revision,
         created_at::text AS "createdAt", updated_at::text AS "updatedAt",
         deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
  FROM library.personal_label
  WHERE route = input.route AND account_id = input.account_id AND label_id = input.label_id
    AND (input.include_deleted OR deleted_at IS NULL)
  LIMIT 1
) AS point;
