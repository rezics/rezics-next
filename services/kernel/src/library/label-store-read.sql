-- Unique PK equality uses the prepared parameters, as Entry point reads do.
-- LATERAL ORDER BY PK LIMIT 1 Seq Scanned personal_label once per parent under
-- generic prepared plans: LIMIT 1 lets Seq Scan stop early on a few hundred rows.
-- Direct PK binds keep personal_label_pkey. Filter include_deleted on that row
-- so OR deleted_at IS NULL cannot hide the unique index. Project createdAt as
-- insert RETURNING does so Reylo decodes timestamptz text.
WITH point AS MATERIALIZED (
  SELECT label.label_id AS id, label.normalized_name AS name, label.revision,
         label.created_at::text AS "createdAt", label.updated_at::text AS "updatedAt",
         label.deleted_at::text AS "deletedAt", label.purge_after::text AS "purgeAfter"
  FROM library.personal_label AS label
  WHERE label.route = :route::integer
    AND label.account_id = :account_id::uuid
    AND label.label_id = :label_id::uuid
)
SELECT point.id, point.name, point.revision, point."createdAt", point."updatedAt",
       point."deletedAt", point."purgeAfter"
FROM point
WHERE :include_deleted::boolean OR point."deletedAt" IS NULL;
