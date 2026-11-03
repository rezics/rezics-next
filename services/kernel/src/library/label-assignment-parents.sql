WITH keys AS MATERIALIZED (
  SELECT label_id FROM unnest(:label_ids::uuid[]) AS labels(label_id) ORDER BY label_id
)
SELECT parent.*
FROM keys
CROSS JOIN LATERAL (
  SELECT label_id AS "labelId", revision, deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
  FROM library.personal_label
  WHERE route = :route AND account_id = :account_id AND label_id = keys.label_id
  FOR SHARE
) AS parent;
