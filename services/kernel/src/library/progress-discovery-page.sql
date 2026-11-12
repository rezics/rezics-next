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
  -- Each filter selector drives its lateral index seek. Nonmatching arms do no session scan.
  (
    SELECT page.route, page.session_id, page.started_at
    FROM (SELECT * FROM args WHERE filter_kind = 'owner' AND subject_id IS NULL) AS selected
    CROSS JOIN LATERAL (
      SELECT session.route, session.session_id, session.started_at
      FROM library.progress_session AS session
      WHERE session.route = selected.route AND session.account_id = selected.account_id
        AND session.state <> 'retired'
        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
    ) AS page
  )
  UNION ALL
  (
    SELECT page.route, page.session_id, page.started_at
    FROM (SELECT * FROM args WHERE filter_kind = 'subject' AND subject_id IS NOT NULL) AS selected
    CROSS JOIN LATERAL (
      SELECT session.route, session.session_id, session.started_at
      FROM library.progress_session AS session
      WHERE session.route = selected.route AND session.account_id = selected.account_id
        AND session.state <> 'retired' AND session.subject_id = selected.subject_id
        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
    ) AS page
  )
  UNION ALL
  (
    SELECT page.route, page.session_id, page.started_at
    FROM (SELECT * FROM args WHERE filter_kind = 'state' AND subject_id IS NULL) AS selected
    CROSS JOIN LATERAL (
      SELECT session.route, session.session_id, session.started_at
      FROM library.progress_session AS session
      WHERE session.route = selected.route AND session.account_id = selected.account_id
        AND session.state <> 'retired' AND session.state = selected.state_filter
        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
    ) AS page
  )
  UNION ALL
  (
    SELECT page.route, page.session_id, page.started_at
    FROM (SELECT * FROM args WHERE filter_kind = 'mode' AND subject_id IS NULL) AS selected
    CROSS JOIN LATERAL (
      SELECT session.route, session.session_id, session.started_at
      FROM library.progress_session AS session
      WHERE session.route = selected.route AND session.account_id = selected.account_id
        AND session.state <> 'retired' AND session.mode = selected.mode_filter
        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
    ) AS page
  )
  UNION ALL
  (
    SELECT page.route, page.session_id, page.started_at
    FROM (SELECT * FROM args WHERE filter_kind = 'profile' AND subject_id IS NULL) AS selected
    CROSS JOIN LATERAL (
      SELECT session.route, session.session_id, session.started_at
      FROM library.progress_session AS session
      WHERE session.route = selected.route AND session.account_id = selected.account_id
        AND session.state <> 'retired'
        AND session.library_profile_pin ->> 'profileId' = selected.profile_filter
        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
    ) AS page
  )
  UNION ALL
  (
    SELECT page.route, page.session_id, page.started_at
    FROM (SELECT * FROM args WHERE filter_kind = 'subject_state' AND subject_id IS NOT NULL) AS selected
    CROSS JOIN LATERAL (
      SELECT session.route, session.session_id, session.started_at
      FROM library.progress_session AS session
      WHERE session.route = selected.route AND session.account_id = selected.account_id
        AND session.state <> 'retired' AND session.subject_id = selected.subject_id
        AND session.state = selected.state_filter
        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
    ) AS page
  )
  UNION ALL
  (
    SELECT page.route, page.session_id, page.started_at
    FROM (SELECT * FROM args WHERE filter_kind = 'subject_mode' AND subject_id IS NOT NULL) AS selected
    CROSS JOIN LATERAL (
      SELECT session.route, session.session_id, session.started_at
      FROM library.progress_session AS session
      WHERE session.route = selected.route AND session.account_id = selected.account_id
        AND session.state <> 'retired' AND session.subject_id = selected.subject_id
        AND session.mode = selected.mode_filter
        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
    ) AS page
  )
  UNION ALL
  (
    SELECT page.route, page.session_id, page.started_at
    FROM (SELECT * FROM args WHERE filter_kind = 'subject_profile' AND subject_id IS NOT NULL) AS selected
    CROSS JOIN LATERAL (
      SELECT session.route, session.session_id, session.started_at
      FROM library.progress_session AS session
      WHERE session.route = selected.route AND session.account_id = selected.account_id
        AND session.state <> 'retired' AND session.subject_id = selected.subject_id
        AND session.library_profile_pin ->> 'profileId' = selected.profile_filter
        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
    ) AS page
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
