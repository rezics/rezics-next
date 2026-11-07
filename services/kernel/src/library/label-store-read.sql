-- Unique PK as a parameterized nested-loop inner so generic prepared plans
-- use personal_label_pkey. NOT MATERIALIZED inlined the one-row CTE and Seq
-- Scanned a small owner catalogue (FULL warmup 34/34 nodes). LATERAL LIMIT 1
-- also Seq Scanned because LIMIT 1 lets Seq Scan stop early. Equality filters
-- still Seq Scan when a custom plan inlines the UUID into a tiny catalogue.
-- MATERIALIZED input, Access ROW-bounded primary-key range, exact key equalities,
-- and OFFSET 0 keep personal_label_pkey when generic plans cannot reduce the
-- ROW bound. ORDER BY names the primary key with no LIMIT and no include-deleted OR. Filter
-- include-deleted in the store after this unique row. Project createdAt as
-- insert RETURNING does so Reylo decodes timestamptz text.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id
)
SELECT point.id, point.name, point.revision, point."createdAt", point."updatedAt",
       point."deletedAt", point."purgeAfter"
FROM input
CROSS JOIN LATERAL (
  SELECT label.label_id AS id, label.normalized_name AS name, label.revision,
         label.created_at::text AS "createdAt", label.updated_at::text AS "updatedAt",
         label.deleted_at::text AS "deletedAt", label.purge_after::text AS "purgeAfter"
  FROM library.personal_label AS label
  WHERE ROW(label.route, label.account_id, label.label_id)
          >= ROW(input.route, input.account_id, input.label_id)
    AND ROW(label.route, label.account_id, label.label_id)
          <= ROW(input.route, input.account_id, input.label_id)
    AND label.route = input.route
    AND label.account_id = input.account_id
    AND label.label_id = input.label_id
  ORDER BY label.route, label.account_id, label.label_id
  OFFSET 0
) AS point;
