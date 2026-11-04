WITH args AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :account_id::uuid AS account_id,
         :subject_id::nullable(uuid) AS subject_id,
         :filter_kind::text AS filter_kind,
         :state_filter::text AS state_filter,
         :mode_filter::text AS mode_filter,
         :profile_filter::text AS profile_filter,
         :after_started_at::nullable(timestamptz) AS after_started_at,
         :after_session_id::nullable(uuid) AS after_session_id,
         :has_cursor::boolean AS has_cursor,
         :limit::integer AS page_limit
), candidate_ids AS (
  (
    SELECT session.route, session.session_id, session.started_at
    FROM library.progress_session AS session CROSS JOIN args
    WHERE session.route = args.route AND session.account_id = args.account_id
      AND session.state <> 'retired' AND args.filter_kind = 'owner' AND args.subject_id IS NULL
      AND (NOT args.has_cursor OR session.started_at < args.after_started_at
        OR (session.started_at = args.after_started_at AND session.session_id > args.after_session_id))
    ORDER BY session.started_at DESC, session.session_id LIMIT args.page_limit
  )
  UNION ALL
  (
    SELECT session.route, session.session_id, session.started_at
    FROM library.progress_session AS session CROSS JOIN args
    WHERE session.route = args.route AND session.account_id = args.account_id
      AND session.state <> 'retired' AND args.filter_kind = 'subject' AND session.subject_id = args.subject_id
      AND (NOT args.has_cursor OR session.started_at < args.after_started_at
        OR (session.started_at = args.after_started_at AND session.session_id > args.after_session_id))
    ORDER BY session.started_at DESC, session.session_id LIMIT args.page_limit
  )
  UNION ALL
  (
    SELECT session.route, session.session_id, session.started_at
    FROM library.progress_session AS session CROSS JOIN args
    WHERE session.route = args.route AND session.account_id = args.account_id
      AND session.state <> 'retired' AND args.filter_kind = 'state' AND session.state = args.state_filter
      AND (NOT args.has_cursor OR session.started_at < args.after_started_at
        OR (session.started_at = args.after_started_at AND session.session_id > args.after_session_id))
    ORDER BY session.started_at DESC, session.session_id LIMIT args.page_limit
  )
  UNION ALL
  (
    SELECT session.route, session.session_id, session.started_at
    FROM library.progress_session AS session CROSS JOIN args
    WHERE session.route = args.route AND session.account_id = args.account_id
      AND session.state <> 'retired' AND args.filter_kind = 'mode' AND session.mode = args.mode_filter
      AND (NOT args.has_cursor OR session.started_at < args.after_started_at
        OR (session.started_at = args.after_started_at AND session.session_id > args.after_session_id))
    ORDER BY session.started_at DESC, session.session_id LIMIT args.page_limit
  )
  UNION ALL
  (
    SELECT session.route, session.session_id, session.started_at
    FROM library.progress_session AS session CROSS JOIN args
    WHERE session.route = args.route AND session.account_id = args.account_id
      AND session.state <> 'retired' AND args.filter_kind = 'profile'
      AND session.library_profile_pin ->> 'profileId' = args.profile_filter
      AND (NOT args.has_cursor OR session.started_at < args.after_started_at
        OR (session.started_at = args.after_started_at AND session.session_id > args.after_session_id))
    ORDER BY session.started_at DESC, session.session_id LIMIT args.page_limit
  )
  UNION ALL
  (
    SELECT session.route, session.session_id, session.started_at
    FROM library.progress_session AS session CROSS JOIN args
    WHERE session.route = args.route AND session.account_id = args.account_id
      AND session.state <> 'retired' AND args.filter_kind = 'subject_state'
      AND session.subject_id = args.subject_id AND session.state = args.state_filter
      AND (NOT args.has_cursor OR session.started_at < args.after_started_at
        OR (session.started_at = args.after_started_at AND session.session_id > args.after_session_id))
    ORDER BY session.started_at DESC, session.session_id LIMIT args.page_limit
  )
  UNION ALL
  (
    SELECT session.route, session.session_id, session.started_at
    FROM library.progress_session AS session CROSS JOIN args
    WHERE session.route = args.route AND session.account_id = args.account_id
      AND session.state <> 'retired' AND args.filter_kind = 'subject_mode'
      AND session.subject_id = args.subject_id AND session.mode = args.mode_filter
      AND (NOT args.has_cursor OR session.started_at < args.after_started_at
        OR (session.started_at = args.after_started_at AND session.session_id > args.after_session_id))
    ORDER BY session.started_at DESC, session.session_id LIMIT args.page_limit
  )
  UNION ALL
  (
    SELECT session.route, session.session_id, session.started_at
    FROM library.progress_session AS session CROSS JOIN args
    WHERE session.route = args.route AND session.account_id = args.account_id
      AND session.state <> 'retired' AND args.filter_kind = 'subject_profile'
      AND session.subject_id = args.subject_id
      AND session.library_profile_pin ->> 'profileId' = args.profile_filter
      AND (NOT args.has_cursor OR session.started_at < args.after_started_at
        OR (session.started_at = args.after_started_at AND session.session_id > args.after_session_id))
    ORDER BY session.started_at DESC, session.session_id LIMIT args.page_limit
  )
)
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
FROM candidate_ids AS candidate
JOIN library.progress_session AS session
  ON session.route = candidate.route AND session.session_id = candidate.session_id
ORDER BY candidate.started_at DESC, candidate.session_id
LIMIT (SELECT page_limit FROM args);
