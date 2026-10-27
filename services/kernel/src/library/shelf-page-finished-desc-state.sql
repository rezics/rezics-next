WITH args AS (
  SELECT :has_after::boolean AS has_after, :seek_key::nullable(timestamptz) AS seek_key,
         :subject_id::uuid AS subject_id, :take::integer AS take
), scoped AS NOT MATERIALIZED (
  SELECT subject_id, state, revision, created_at, updated_at, activity_at, finished_at
  FROM library.entry
  WHERE route = :route::integer AND account_id = :account_id::uuid
    AND state = :state::text
), candidates AS (
  (SELECT * FROM scoped WHERE NOT (SELECT has_after FROM args)
   ORDER BY finished_at DESC NULLS LAST, subject_id ASC LIMIT (SELECT take FROM args))
UNION ALL
  (SELECT * FROM scoped WHERE (SELECT has_after FROM args) AND (SELECT seek_key FROM args) IS NOT NULL AND finished_at < (SELECT seek_key FROM args)
   ORDER BY finished_at DESC NULLS LAST, subject_id ASC LIMIT (SELECT take FROM args))
UNION ALL
  (SELECT * FROM scoped WHERE (SELECT has_after FROM args) AND (SELECT seek_key FROM args) IS NOT NULL AND finished_at = (SELECT seek_key FROM args) AND subject_id > (SELECT subject_id FROM args)
   ORDER BY finished_at DESC NULLS LAST, subject_id ASC LIMIT (SELECT take FROM args))
UNION ALL
  (SELECT * FROM scoped WHERE (SELECT has_after FROM args) AND (SELECT seek_key FROM args) IS NOT NULL AND finished_at IS NULL
   ORDER BY finished_at DESC NULLS LAST, subject_id ASC LIMIT (SELECT take FROM args))
UNION ALL
  (SELECT * FROM scoped WHERE (SELECT has_after FROM args) AND (SELECT seek_key FROM args) IS NULL AND finished_at IS NULL AND subject_id > (SELECT subject_id FROM args)
   ORDER BY finished_at DESC NULLS LAST, subject_id ASC LIMIT (SELECT take FROM args))
)
SELECT subject_id AS "subjectId", state, revision,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
       to_char(activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastActivityAt",
       to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "finishedAt"
FROM candidates
ORDER BY finished_at DESC NULLS LAST, subject_id ASC
LIMIT (SELECT take FROM args);
