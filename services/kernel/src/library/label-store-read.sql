-- Correlated bounded branches retain index predicates under generic prepared plans.
-- Split include_deleted like prefix splits upper_bound so OR cannot hide the primary key.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id,
         :include_deleted::boolean AS include_deleted
), point AS MATERIALIZED (
  SELECT a.* FROM input CROSS JOIN LATERAL (
    SELECT label_id AS id, normalized_name AS name, revision,
           created_at::text AS "createdAt", updated_at::text AS "updatedAt",
           deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
    FROM library.personal_label
    WHERE route = input.route AND account_id = input.account_id AND label_id = input.label_id
    ORDER BY label_id
    LIMIT 1
  ) a WHERE input.include_deleted
  UNION ALL
  SELECT a.* FROM input CROSS JOIN LATERAL (
    SELECT label_id AS id, normalized_name AS name, revision,
           created_at::text AS "createdAt", updated_at::text AS "updatedAt",
           deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
    FROM library.personal_label
    WHERE route = input.route AND account_id = input.account_id AND label_id = input.label_id
      AND deleted_at IS NULL
    ORDER BY label_id
    LIMIT 1
  ) a WHERE NOT input.include_deleted
)
SELECT * FROM point;
