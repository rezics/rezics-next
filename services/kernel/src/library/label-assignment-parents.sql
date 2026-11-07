-- Unique PK as a parameterized nested-loop inner so generic prepared plans
-- use personal_label_pkey. NOT MATERIALIZED inlined the one-row CTE; LATERAL
-- LIMIT 1 Seq Scanned because LIMIT 1 lets Seq Scan stop early. Equality
-- filters still Seq Scan when a custom plan inlines the UUID. MATERIALIZED
-- input, Access ROW-bounded primary-key range, exact key equalities, and OFFSET 0
-- keep personal_label_pkey when the CTE values are constants or generic plans
-- cannot reduce the ROW bound. ORDER BY names the primary key with no LIMIT.
-- FOR SHARE preserves parent lifecycle serialization. Filter deleted parents in
-- the store after this unique row.
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
  WHERE ROW(label.route, label.account_id, label.label_id)
          >= ROW(input.route, input.account_id, keys.label_id)
    AND ROW(label.route, label.account_id, label.label_id)
          <= ROW(input.route, input.account_id, keys.label_id)
    AND label.route = input.route
    AND label.account_id = input.account_id
    AND label.label_id = keys.label_id
  ORDER BY label.route, label.account_id, label.label_id
  OFFSET 0
  FOR SHARE
) AS parent;
