-- Reuse typed scalar input for one-time guards and index seek bounds.
WITH args AS (
  SELECT :has_after::boolean AS has_after, :null_after::boolean AS null_after,
         :after_key::timestamptz AS after_key, :after_subject_id::uuid AS after_subject_id, :budget::integer AS budget
), scoped AS NOT MATERIALIZED (
  SELECT subject_id, state, revision, created_at, updated_at, activity_at, finished_at
  FROM library.entry
  WHERE route = :route::integer AND account_id = :account_id::uuid
    AND type_id = :type_id::uuid
), candidates AS (
  (SELECT * FROM scoped WHERE NOT (SELECT has_after FROM args)
   ORDER BY finished_at ASC NULLS FIRST, subject_id DESC LIMIT (SELECT budget FROM args))
  UNION ALL (SELECT * FROM scoped WHERE (SELECT has_after FROM args) AND (SELECT null_after FROM args)
     AND finished_at IS NULL AND subject_id < (SELECT after_subject_id FROM args)
   ORDER BY finished_at ASC NULLS FIRST, subject_id DESC LIMIT (SELECT budget FROM args))
  UNION ALL (SELECT * FROM scoped WHERE (SELECT has_after FROM args) AND (SELECT null_after FROM args) AND finished_at IS NOT NULL
   ORDER BY finished_at ASC NULLS FIRST, subject_id DESC LIMIT (SELECT budget FROM args))
  UNION ALL (SELECT * FROM scoped WHERE (SELECT has_after FROM args) AND NOT (SELECT null_after FROM args)
     AND finished_at > (SELECT after_key FROM args)
   ORDER BY finished_at ASC NULLS FIRST, subject_id DESC LIMIT (SELECT budget FROM args))
  UNION ALL (SELECT * FROM scoped WHERE (SELECT has_after FROM args) AND NOT (SELECT null_after FROM args)
     AND finished_at = (SELECT after_key FROM args) AND subject_id < (SELECT after_subject_id FROM args)
   ORDER BY finished_at ASC NULLS FIRST, subject_id DESC LIMIT (SELECT budget FROM args))
)
SELECT subject_id::text AS "subjectId", state, revision,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
       to_char(activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastActivityAt",
       to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "finishedAt"
FROM candidates
ORDER BY finished_at ASC NULLS FIRST, subject_id DESC LIMIT (SELECT budget FROM args);
