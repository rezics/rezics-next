import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    account_id: string;
    subject_id?: string | null;
    filter_kind: string;
    state_filter: string;
    mode_filter: string;
    profile_filter: string;
    after_started_at?: string | null;
    after_session_id?: string | null;
    has_cursor: boolean;
    limit: number;
};
export type Row = {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
    versionSubjectId: string | null;
    libraryProfilePin: Json;
    mode: "scalar_amount" | "cursor_position" | "completed_units";
    unit: string;
    total: string | null;
    amount: string | null;
    additionalMeasures: Json;
    locator: string | null;
    position: string | null;
    completedUnitCount: number;
    state: "active" | "completed" | "abandoned" | "retired";
    revision: number;
    startedAt: string;
    completedAt: string | null;
    transactionId: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "WITH args AS NOT MATERIALIZED (\n  SELECT $1::integer AS route,\n         $2::uuid AS account_id,\n         $3::uuid AS subject_id,\n         $4::text AS filter_kind,\n         $5::text AS state_filter,\n         $6::text AS mode_filter,\n         $7::text AS profile_filter,\n         $8::timestamptz AS after_started_at,\n         $9::uuid AS after_session_id,\n         $10::boolean AS has_cursor,\n         $11::integer AS page_limit\n), candidate_ids AS (\n  -- Each filter selector drives its lateral index seek. Nonmatching arms do no session scan.\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'owner' AND subject_id IS NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired'\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'subject' AND subject_id IS NOT NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.subject_id = selected.subject_id\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'state' AND subject_id IS NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.state = selected.state_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'mode' AND subject_id IS NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.mode = selected.mode_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'profile' AND subject_id IS NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired'\n        AND session.library_profile_pin ->> 'profileId' = selected.profile_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'subject_state' AND subject_id IS NOT NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.subject_id = selected.subject_id\n        AND session.state = selected.state_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'subject_mode' AND subject_id IS NOT NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.subject_id = selected.subject_id\n        AND session.mode = selected.mode_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'subject_profile' AND subject_id IS NOT NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.subject_id = selected.subject_id\n        AND session.library_profile_pin ->> 'profileId' = selected.profile_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n)\nSELECT session.route,\n       session.session_id AS id,\n       session.account_id AS \"accountId\",\n       session.subject_id AS \"subjectId\",\n       session.version_subject_id AS \"versionSubjectId\",\n       session.library_profile_pin AS \"libraryProfilePin\",\n       session.mode,\n       session.unit,\n       session.total::text AS total,\n       session.amount::text AS amount,\n       session.additional_measures AS \"additionalMeasures\",\n       session.locator,\n       session.position::text AS position,\n       session.completed_unit_count AS \"completedUnitCount\",\n       session.state,\n       session.revision,\n       session.started_at::text AS \"startedAt\",\n       session.completed_at::text AS \"completedAt\",\n       session.transaction_id AS \"transactionId\"\nFROM candidate_ids AS candidate\nJOIN library.progress_session AS session\n  ON session.route = candidate.route AND session.session_id = candidate.session_id\nORDER BY candidate.started_at DESC, candidate.session_id\nLIMIT (SELECT page_limit FROM args);";
export declare const raw: "WITH args AS NOT MATERIALIZED (\n  SELECT :route::integer AS route,\n         :account_id::uuid AS account_id,\n         :subject_id::nullable(uuid) AS subject_id,\n         :filter_kind::text AS filter_kind,\n         :state_filter::text AS state_filter,\n         :mode_filter::text AS mode_filter,\n         :profile_filter::text AS profile_filter,\n         :after_started_at::nullable(timestamptz) AS after_started_at,\n         :after_session_id::nullable(uuid) AS after_session_id,\n         :has_cursor::boolean AS has_cursor,\n         :limit::integer AS page_limit\n), candidate_ids AS (\n  -- Each filter selector drives its lateral index seek. Nonmatching arms do no session scan.\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'owner' AND subject_id IS NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired'\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'subject' AND subject_id IS NOT NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.subject_id = selected.subject_id\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'state' AND subject_id IS NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.state = selected.state_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'mode' AND subject_id IS NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.mode = selected.mode_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'profile' AND subject_id IS NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired'\n        AND session.library_profile_pin ->> 'profileId' = selected.profile_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'subject_state' AND subject_id IS NOT NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.subject_id = selected.subject_id\n        AND session.state = selected.state_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'subject_mode' AND subject_id IS NOT NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.subject_id = selected.subject_id\n        AND session.mode = selected.mode_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n  UNION ALL\n  (\n    SELECT page.route, page.session_id, page.started_at\n    FROM (SELECT * FROM args WHERE filter_kind = 'subject_profile' AND subject_id IS NOT NULL) AS selected\n    CROSS JOIN LATERAL (\n      SELECT session.route, session.session_id, session.started_at\n      FROM library.progress_session AS session\n      WHERE session.route = selected.route AND session.account_id = selected.account_id\n        AND session.state <> 'retired' AND session.subject_id = selected.subject_id\n        AND session.library_profile_pin ->> 'profileId' = selected.profile_filter\n        AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at\n          OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))\n      ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)\n    ) AS page\n  )\n)\nSELECT session.route,\n       session.session_id AS id,\n       session.account_id AS \"accountId\",\n       session.subject_id AS \"subjectId\",\n       session.version_subject_id AS \"versionSubjectId\",\n       session.library_profile_pin AS \"libraryProfilePin\",\n       session.mode,\n       session.unit,\n       session.total::text AS total,\n       session.amount::text AS amount,\n       session.additional_measures AS \"additionalMeasures\",\n       session.locator,\n       session.position::text AS position,\n       session.completed_unit_count AS \"completedUnitCount\",\n       session.state,\n       session.revision,\n       session.started_at::text AS \"startedAt\",\n       session.completed_at::text AS \"completedAt\",\n       session.transaction_id AS \"transactionId\"\nFROM candidate_ids AS candidate\nJOIN library.progress_session AS session\n  ON session.route = candidate.route AND session.session_id = candidate.session_id\nORDER BY candidate.started_at DESC, candidate.session_id\nLIMIT (SELECT page_limit FROM args);\n";
export declare const params: readonly ["route", "account_id", "subject_id", "filter_kind", "state_filter", "mode_filter", "profile_filter", "after_started_at", "after_session_id", "has_cursor", "limit"];
/**
 * ```sql
 * WITH args AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route,
 *          :account_id::uuid AS account_id,
 *          :subject_id::nullable(uuid) AS subject_id,
 *          :filter_kind::text AS filter_kind,
 *          :state_filter::text AS state_filter,
 *          :mode_filter::text AS mode_filter,
 *          :profile_filter::text AS profile_filter,
 *          :after_started_at::nullable(timestamptz) AS after_started_at,
 *          :after_session_id::nullable(uuid) AS after_session_id,
 *          :has_cursor::boolean AS has_cursor,
 *          :limit::integer AS page_limit
 * ), candidate_ids AS (
 *   -- Each filter selector drives its lateral index seek. Nonmatching arms do no session scan.
 *   (
 *     SELECT page.route, page.session_id, page.started_at
 *     FROM (SELECT * FROM args WHERE filter_kind = 'owner' AND subject_id IS NULL) AS selected
 *     CROSS JOIN LATERAL (
 *       SELECT session.route, session.session_id, session.started_at
 *       FROM library.progress_session AS session
 *       WHERE session.route = selected.route AND session.account_id = selected.account_id
 *         AND session.state <> 'retired'
 *         AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
 *           OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
 *       ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
 *     ) AS page
 *   )
 *   UNION ALL
 *   (
 *     SELECT page.route, page.session_id, page.started_at
 *     FROM (SELECT * FROM args WHERE filter_kind = 'subject' AND subject_id IS NOT NULL) AS selected
 *     CROSS JOIN LATERAL (
 *       SELECT session.route, session.session_id, session.started_at
 *       FROM library.progress_session AS session
 *       WHERE session.route = selected.route AND session.account_id = selected.account_id
 *         AND session.state <> 'retired' AND session.subject_id = selected.subject_id
 *         AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
 *           OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
 *       ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
 *     ) AS page
 *   )
 *   UNION ALL
 *   (
 *     SELECT page.route, page.session_id, page.started_at
 *     FROM (SELECT * FROM args WHERE filter_kind = 'state' AND subject_id IS NULL) AS selected
 *     CROSS JOIN LATERAL (
 *       SELECT session.route, session.session_id, session.started_at
 *       FROM library.progress_session AS session
 *       WHERE session.route = selected.route AND session.account_id = selected.account_id
 *         AND session.state <> 'retired' AND session.state = selected.state_filter
 *         AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
 *           OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
 *       ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
 *     ) AS page
 *   )
 *   UNION ALL
 *   (
 *     SELECT page.route, page.session_id, page.started_at
 *     FROM (SELECT * FROM args WHERE filter_kind = 'mode' AND subject_id IS NULL) AS selected
 *     CROSS JOIN LATERAL (
 *       SELECT session.route, session.session_id, session.started_at
 *       FROM library.progress_session AS session
 *       WHERE session.route = selected.route AND session.account_id = selected.account_id
 *         AND session.state <> 'retired' AND session.mode = selected.mode_filter
 *         AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
 *           OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
 *       ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
 *     ) AS page
 *   )
 *   UNION ALL
 *   (
 *     SELECT page.route, page.session_id, page.started_at
 *     FROM (SELECT * FROM args WHERE filter_kind = 'profile' AND subject_id IS NULL) AS selected
 *     CROSS JOIN LATERAL (
 *       SELECT session.route, session.session_id, session.started_at
 *       FROM library.progress_session AS session
 *       WHERE session.route = selected.route AND session.account_id = selected.account_id
 *         AND session.state <> 'retired'
 *         AND session.library_profile_pin ->> 'profileId' = selected.profile_filter
 *         AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
 *           OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
 *       ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
 *     ) AS page
 *   )
 *   UNION ALL
 *   (
 *     SELECT page.route, page.session_id, page.started_at
 *     FROM (SELECT * FROM args WHERE filter_kind = 'subject_state' AND subject_id IS NOT NULL) AS selected
 *     CROSS JOIN LATERAL (
 *       SELECT session.route, session.session_id, session.started_at
 *       FROM library.progress_session AS session
 *       WHERE session.route = selected.route AND session.account_id = selected.account_id
 *         AND session.state <> 'retired' AND session.subject_id = selected.subject_id
 *         AND session.state = selected.state_filter
 *         AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
 *           OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
 *       ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
 *     ) AS page
 *   )
 *   UNION ALL
 *   (
 *     SELECT page.route, page.session_id, page.started_at
 *     FROM (SELECT * FROM args WHERE filter_kind = 'subject_mode' AND subject_id IS NOT NULL) AS selected
 *     CROSS JOIN LATERAL (
 *       SELECT session.route, session.session_id, session.started_at
 *       FROM library.progress_session AS session
 *       WHERE session.route = selected.route AND session.account_id = selected.account_id
 *         AND session.state <> 'retired' AND session.subject_id = selected.subject_id
 *         AND session.mode = selected.mode_filter
 *         AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
 *           OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
 *       ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
 *     ) AS page
 *   )
 *   UNION ALL
 *   (
 *     SELECT page.route, page.session_id, page.started_at
 *     FROM (SELECT * FROM args WHERE filter_kind = 'subject_profile' AND subject_id IS NOT NULL) AS selected
 *     CROSS JOIN LATERAL (
 *       SELECT session.route, session.session_id, session.started_at
 *       FROM library.progress_session AS session
 *       WHERE session.route = selected.route AND session.account_id = selected.account_id
 *         AND session.state <> 'retired' AND session.subject_id = selected.subject_id
 *         AND session.library_profile_pin ->> 'profileId' = selected.profile_filter
 *         AND (NOT selected.has_cursor OR session.started_at < selected.after_started_at
 *           OR (session.started_at = selected.after_started_at AND session.session_id > selected.after_session_id))
 *       ORDER BY session.started_at DESC, session.session_id LIMIT (SELECT page_limit FROM args)
 *     ) AS page
 *   )
 * )
 * SELECT session.route,
 *        session.session_id AS id,
 *        session.account_id AS "accountId",
 *        session.subject_id AS "subjectId",
 *        session.version_subject_id AS "versionSubjectId",
 *        session.library_profile_pin AS "libraryProfilePin",
 *        session.mode,
 *        session.unit,
 *        session.total::text AS total,
 *        session.amount::text AS amount,
 *        session.additional_measures AS "additionalMeasures",
 *        session.locator,
 *        session.position::text AS position,
 *        session.completed_unit_count AS "completedUnitCount",
 *        session.state,
 *        session.revision,
 *        session.started_at::text AS "startedAt",
 *        session.completed_at::text AS "completedAt",
 *        session.transaction_id AS "transactionId"
 * FROM candidate_ids AS candidate
 * JOIN library.progress_session AS session
 *   ON session.route = candidate.route AND session.session_id = candidate.session_id
 * ORDER BY candidate.started_at DESC, candidate.session_id
 * LIMIT (SELECT page_limit FROM args);
 * ```
 */
declare const query: Query<{
    route: number;
    account_id: string;
    subject_id?: string | null;
    filter_kind: string;
    state_filter: string;
    mode_filter: string;
    profile_filter: string;
    after_started_at?: string | null;
    after_session_id?: string | null;
    has_cursor: boolean;
    limit: number;
}, {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
    versionSubjectId: string | null;
    libraryProfilePin: Json;
    mode: "scalar_amount" | "cursor_position" | "completed_units";
    unit: string;
    total: string | null;
    amount: string | null;
    additionalMeasures: Json;
    locator: string | null;
    position: string | null;
    completedUnitCount: number;
    state: "active" | "completed" | "abandoned" | "retired";
    revision: number;
    startedAt: string;
    completedAt: string | null;
    transactionId: string;
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
