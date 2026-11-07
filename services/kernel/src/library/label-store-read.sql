-- Correlated bounded branches retain index predicates under generic prepared plans.
-- Split include_deleted like prefix splits upper_bound so OR cannot hide the primary key.
-- Name createdAt on the outer SELECT the same way insert RETURNING does so Reylo still
-- decodes timestamptz text; SELECT * through a LATERAL star made asRecord see Invalid Date.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id,
         :include_deleted::boolean AS include_deleted
)
SELECT live.label_id AS id, live.normalized_name AS name, live.revision,
       live.created_at::text AS "createdAt", live.updated_at::text AS "updatedAt",
       live.deleted_at::text AS "deletedAt", live.purge_after::text AS "purgeAfter"
FROM input
CROSS JOIN LATERAL (
  SELECT label_id, normalized_name, revision, created_at, updated_at, deleted_at, purge_after
  FROM library.personal_label
  WHERE route = input.route AND account_id = input.account_id AND label_id = input.label_id
  ORDER BY label_id
  LIMIT 1
) AS live
WHERE input.include_deleted
UNION ALL
SELECT live.label_id AS id, live.normalized_name AS name, live.revision,
       live.created_at::text AS "createdAt", live.updated_at::text AS "updatedAt",
       live.deleted_at::text AS "deletedAt", live.purge_after::text AS "purgeAfter"
FROM input
CROSS JOIN LATERAL (
  SELECT label_id, normalized_name, revision, created_at, updated_at, deleted_at, purge_after
  FROM library.personal_label
  WHERE route = input.route AND account_id = input.account_id AND label_id = input.label_id
    AND deleted_at IS NULL
  ORDER BY label_id
  LIMIT 1
) AS live
WHERE NOT input.include_deleted;
