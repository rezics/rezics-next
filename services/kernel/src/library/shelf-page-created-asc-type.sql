-- Disjoint bounded ranges keep both halves of the mixed-direction seek in index conditions.
WITH args AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :type_id::uuid AS type_id,
         :has_after::boolean AS has_after, :after_created_at::timestamptz AS after_created_at,
         :after_subject_id::uuid AS after_subject_id, :count::integer AS page_limit
), scoped AS NOT MATERIALIZED (
  SELECT subject_id, state, revision, created_at, updated_at, activity_at, finished_at
  FROM library.entry
  WHERE route = (SELECT route FROM args) AND account_id = (SELECT account_id FROM args)
    AND type_id = (SELECT type_id FROM args)
), candidates AS (
  (SELECT scoped.* FROM scoped WHERE NOT (SELECT has_after FROM args)
   ORDER BY created_at ASC, subject_id DESC LIMIT (SELECT page_limit FROM args))
  UNION ALL
  (SELECT scoped.* FROM scoped WHERE (SELECT has_after FROM args) AND created_at = (SELECT after_created_at FROM args)
     AND subject_id < (SELECT after_subject_id FROM args)
   ORDER BY created_at ASC, subject_id DESC LIMIT (SELECT page_limit FROM args))
  UNION ALL
  (SELECT scoped.* FROM scoped WHERE (SELECT has_after FROM args) AND created_at > (SELECT after_created_at FROM args)
   ORDER BY created_at ASC, subject_id DESC LIMIT (SELECT page_limit FROM args))
)
SELECT subject_id AS "subjectId", state, revision,
       created_at::text AS "createdAt", updated_at::text AS "updatedAt",
       activity_at::text AS "lastActivityAt", finished_at::text AS "finishedAt"
FROM candidates
ORDER BY created_at ASC, subject_id DESC
LIMIT (SELECT page_limit FROM args);
