-- PK equality on the table; include_deleted filters that one row so a generic
-- prepared plan cannot hide the unique index behind OR deleted_at IS NULL.
-- ORDER BY names the primary key so generic plans keep the unique index rather
-- than Seq Scanning the owner catalogue to satisfy ORDER BY label_id LIMIT 1.
-- Project createdAt as insert RETURNING does so Reylo decodes timestamptz text.
-- UNION ALL of include_deleted made the LATERAL created_at type reach Reylo as
-- binary timestamptz and asRecord saw Invalid Date. Prefix still UNION ALLs
-- upper_bound because those branches project names and ids only.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :label_id::uuid AS label_id,
         :include_deleted::boolean AS include_deleted
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
  LIMIT 1
) AS point
WHERE input.include_deleted OR point."deletedAt" IS NULL;
