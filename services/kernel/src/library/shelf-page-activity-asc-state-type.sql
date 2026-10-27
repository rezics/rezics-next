WITH args AS MATERIALIZED (SELECT :after_key::nullable(timestamptz) AS after_key, :after_subject_id::uuid AS after_subject_id), scoped AS NOT MATERIALIZED (
  SELECT subject_id, activity_at FROM library.entry
  WHERE route = :route::integer AND account_id = :account_id::uuid AND state = :state::text AND type_id = :type_id::uuid
), candidates AS (
  (SELECT scoped.* FROM scoped WHERE (SELECT after_key FROM args) IS NULL
   ORDER BY activity_at ASC NULLS LAST, subject_id DESC LIMIT :first_limit::integer)
  UNION ALL
  (SELECT scoped.* FROM scoped WHERE (SELECT after_key FROM args) IS NOT NULL AND activity_at > (SELECT after_key FROM args)
   ORDER BY activity_at ASC NULLS LAST, subject_id DESC LIMIT :later_limit::integer)
  UNION ALL
  (SELECT scoped.* FROM scoped WHERE (SELECT after_key FROM args) IS NOT NULL AND activity_at = (SELECT after_key FROM args) AND subject_id < (SELECT after_subject_id FROM args)
   ORDER BY subject_id DESC LIMIT :tie_limit::integer)
), page AS MATERIALIZED (SELECT * FROM candidates ORDER BY activity_at ASC NULLS LAST, subject_id DESC LIMIT :limit::integer)
SELECT page.subject_id AS "subjectId", entry.state, entry.revision,
       to_char(entry.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
       to_char(entry.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
       to_char(page.activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastActivityAt",
       to_char(entry.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "finishedAt"
FROM page CROSS JOIN LATERAL (
  SELECT state, revision, created_at, updated_at, finished_at FROM library.entry
  WHERE route = :row_route::integer AND account_id = :row_account_id::uuid AND subject_id = page.subject_id LIMIT 1
) entry ORDER BY page.activity_at ASC NULLS LAST, page.subject_id DESC;
