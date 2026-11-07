WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT label_id FROM unnest(:label_ids::uuid[]) AS labels(label_id) ORDER BY label_id
)
SELECT parent.*
FROM input
CROSS JOIN keys
CROSS JOIN LATERAL (
  SELECT label_id AS "labelId", revision, deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
  FROM library.personal_label
  WHERE route = input.route AND account_id = input.account_id AND label_id = keys.label_id
  LIMIT 1
  FOR SHARE
) AS parent;
