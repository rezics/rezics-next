-- Unique PK equality uses the prepared parameters, as Entry point reads do.
-- LATERAL ORDER BY PK LIMIT 1 Seq Scanned personal_label once per parent under
-- generic prepared plans: LIMIT 1 lets Seq Scan stop early on a few hundred rows.
-- A wrapping CTE plus OR include-deleted also Seq Scanned all 34 FULL parents.
-- Filter include-deleted in the store after this unique row. Project createdAt
-- as insert RETURNING does so Reylo decodes timestamptz text.
SELECT label_id AS id, normalized_name AS name, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
FROM library.personal_label
WHERE route = :route AND account_id = :account_id AND label_id = :label_id;
