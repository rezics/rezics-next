-- Unique PK as a parameterized nested-loop inner so generic prepared plans
-- use personal_label_pkey. Top-level PK equality Seq Scanned a small owner
-- catalogue; LATERAL LIMIT 1 also Seq Scanned because LIMIT 1 lets Seq Scan
-- stop early. ORDER BY names the primary key with no LIMIT and no
-- include-deleted OR. Filter include-deleted in the store after this unique
-- row. Project createdAt as insert RETURNING does so Reylo decodes timestamptz
-- text.
WITH input AS NOT MATERIALIZED (
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
  WHERE label.route = input.route AND label.account_id = input.account_id
    AND label.label_id = input.label_id
  ORDER BY label.route, label.account_id, label.label_id
) AS point;
