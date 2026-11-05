-- Supplied reservation parents only; no deleted-parent catalogue scan or read-time repair.
WITH keys AS MATERIALIZED (
  SELECT label_id FROM unnest(:label_ids::uuid[]) AS labels(label_id)
)
SELECT parent.* FROM keys CROSS JOIN LATERAL (
  SELECT label_id AS "labelId", deleted_at IS NULL AS live
  FROM library.personal_label
  WHERE route = :route AND account_id = :account_id AND label_id = keys.label_id
  -- Preserve parameterized primary-key points instead of flattening into an owner-history join.
  OFFSET 0
) AS parent;
