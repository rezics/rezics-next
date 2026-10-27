WITH args AS (SELECT :after_key::nullable(timestamptz) AS key, :take::integer AS take),
scoped AS NOT MATERIALIZED (
  SELECT subject_id, state, revision, created_at, updated_at, activity_at, finished_at
  FROM library.entry
  WHERE route = :route::integer AND account_id = :account_id::uuid
), candidates AS (
  (SELECT * FROM scoped WHERE (SELECT key FROM args) IS NULL
   ORDER BY activity_at DESC, subject_id ASC LIMIT (SELECT take FROM args))
  UNION ALL
  (SELECT * FROM scoped
   WHERE (SELECT key FROM args) IS NOT NULL AND activity_at < (SELECT key FROM args)
   ORDER BY activity_at DESC, subject_id ASC LIMIT (SELECT take FROM args))
  UNION ALL
  (SELECT * FROM scoped
   WHERE (SELECT key FROM args) IS NOT NULL AND activity_at = (SELECT key FROM args)
     AND subject_id > :after_subject_id::nullable(uuid)
   ORDER BY activity_at DESC, subject_id ASC LIMIT (SELECT take FROM args))
)
SELECT subject_id AS "subjectId", state, revision,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
       to_char(activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastActivityAt",
       to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "finishedAt"
FROM candidates
ORDER BY activity_at DESC, subject_id ASC LIMIT (SELECT take FROM args);
