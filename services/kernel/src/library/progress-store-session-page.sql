WITH args AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :subject_id::uuid AS subject_id,
         :after_started_at::timestamptz AS after_started_at,
         :after_session_id::uuid AS after_session_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
),
candidates AS (
(
  SELECT session.route,
         session.session_id AS id,
         session.account_id AS "accountId",
         session.subject_id AS "subjectId",
         session.version_subject_id AS "versionSubjectId",
         session.library_profile_pin AS "libraryProfilePin",
         session.mode,
         session.unit,
         session.total::text AS total,
         session.amount::text AS amount,
         session.additional_measures AS "additionalMeasures",
         session.locator,
         session.position::text AS position,
         session.completed_unit_count AS "completedUnitCount",
         session.state,
         session.revision,
         session.started_at::text AS "startedAt",
         session.completed_at::text AS "completedAt",
         session.transaction_id AS "transactionId"
  FROM library.progress_session AS session
  CROSS JOIN args
  WHERE session.route = args.route
    AND session.state <> 'retired'
    AND session.account_id = args.account_id
    AND session.subject_id = args.subject_id
    AND (NOT args.has_cursor OR session.started_at < args.after_started_at)
  ORDER BY session.started_at DESC, session.session_id
  LIMIT (SELECT page_limit FROM args)
)
UNION ALL
(
  SELECT session.route,
         session.session_id AS id,
         session.account_id AS "accountId",
         session.subject_id AS "subjectId",
         session.version_subject_id AS "versionSubjectId",
         session.library_profile_pin AS "libraryProfilePin",
         session.mode,
         session.unit,
         session.total::text AS total,
         session.amount::text AS amount,
         session.additional_measures AS "additionalMeasures",
         session.locator,
         session.position::text AS position,
         session.completed_unit_count AS "completedUnitCount",
         session.state,
         session.revision,
         session.started_at::text AS "startedAt",
         session.completed_at::text AS "completedAt",
         session.transaction_id AS "transactionId"
  FROM library.progress_session AS session
  CROSS JOIN args
  WHERE session.route = args.route
    AND session.state <> 'retired'
    AND session.account_id = args.account_id
    AND session.subject_id = args.subject_id
    AND args.has_cursor
    AND session.started_at = args.after_started_at
    AND session.session_id > args.after_session_id
  ORDER BY session.started_at DESC, session.session_id
  LIMIT (SELECT page_limit FROM args)
)
)
SELECT * FROM candidates
ORDER BY "startedAt" DESC, id
LIMIT (SELECT page_limit FROM args);
