WITH args AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id,
         :state::nullable(text) AS state, :type_id::nullable(uuid) AS type_id,
         :has_after::boolean AS has_after,
         :after_priority::nullable(smallint) AS after_priority,
         :after_subject_id::uuid AS after_subject_id, :limit::integer AS page_limit
), scoped AS NOT MATERIALIZED (
  SELECT e.subject_id, e.incarnation_id, e.state, e.revision, e.created_at, e.updated_at,
         e.activity_at, e.finished_at, fact.priority
  FROM library.entry AS e
  LEFT JOIN library.entry_personal_fact AS fact
    ON fact.route=e.route AND fact.account_id=e.account_id AND fact.subject_id=e.subject_id
  WHERE e.route=(SELECT route FROM args) AND e.account_id=(SELECT account_id FROM args)
    AND ((SELECT state FROM args) IS NULL OR e.state=(SELECT state FROM args))
    AND ((SELECT type_id FROM args) IS NULL OR e.type_id=(SELECT type_id FROM args))
), page AS MATERIALIZED (
  SELECT scoped.* FROM scoped CROSS JOIN args
  WHERE NOT args.has_after
     OR (args.after_priority IS NULL AND scoped.priority IS NULL AND scoped.subject_id > args.after_subject_id)
     OR (args.after_priority IS NOT NULL AND
         (scoped.priority IS NULL OR scoped.priority > args.after_priority OR
          (scoped.priority = args.after_priority AND scoped.subject_id > args.after_subject_id)))
  ORDER BY scoped.priority ASC NULLS LAST, scoped.subject_id ASC
  LIMIT (SELECT page_limit FROM args)
)
SELECT subject_id AS "subjectId", incarnation_id AS "incarnationId", state, revision,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
       to_char(activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastActivityAt",
       to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "finishedAt",
       priority
FROM page
ORDER BY priority ASC NULLS LAST, subject_id ASC;
