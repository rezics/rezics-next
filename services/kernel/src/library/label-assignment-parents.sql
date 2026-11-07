WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT label_id FROM unnest(:label_ids::uuid[]) AS labels(label_id) ORDER BY label_id
)
SELECT parent.*
FROM input
CROSS JOIN keys
CROSS JOIN LATERAL (
  SELECT label.label_id AS "labelId", label.revision, label.deleted_at::text AS "deletedAt",
         label.purge_after::text AS "purgeAfter"
  FROM library.personal_label AS label
  WHERE label.route = input.route AND label.account_id = input.account_id
    AND label.label_id = keys.label_id
  ORDER BY label.route, label.account_id, label.label_id
  LIMIT 1
  FOR SHARE
) AS parent;
