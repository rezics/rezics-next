import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    account_id: string;
    subject_id: string;
    after_started_at: string;
    after_session_id: string;
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
    mode: string;
    unit: string;
    total: string | null;
    amount: string | null;
    additionalMeasures: Json;
    locator: string | null;
    position: string | null;
    completedUnitCount: number;
    state: string;
    revision: number;
    startedAt: string;
    completedAt: string | null;
    transactionId: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "WITH args AS NOT MATERIALIZED (\n  SELECT $1::integer AS route,\n         $2::uuid AS account_id,\n         $3::uuid AS subject_id,\n         $4::timestamptz AS after_started_at,\n         $5::uuid AS after_session_id,\n         $6::boolean AS has_cursor,\n         $7::integer AS page_limit\n),\ncandidates AS (\n(\n  SELECT session.route,\n         session.session_id AS id,\n         session.account_id AS \"accountId\",\n         session.subject_id AS \"subjectId\",\n         session.version_subject_id AS \"versionSubjectId\",\n         session.library_profile_pin AS \"libraryProfilePin\",\n         session.mode,\n         session.unit,\n         session.total::text AS total,\n         session.amount::text AS amount,\n         session.additional_measures AS \"additionalMeasures\",\n         session.locator,\n         session.position::text AS position,\n         session.completed_unit_count AS \"completedUnitCount\",\n         session.state,\n         session.revision,\n         session.started_at::text AS \"startedAt\",\n         session.completed_at::text AS \"completedAt\",\n         session.transaction_id AS \"transactionId\"\n  FROM library.progress_session AS session\n  CROSS JOIN args\n  WHERE session.route = args.route\n    AND session.state <> 'retired'\n    AND session.account_id = args.account_id\n    AND session.subject_id = args.subject_id\n    AND NOT args.has_cursor\n  ORDER BY session.started_at DESC, session.session_id\n  LIMIT (SELECT page_limit FROM args)\n)\nUNION ALL\n(\n  SELECT session.route,\n         session.session_id AS id,\n         session.account_id AS \"accountId\",\n         session.subject_id AS \"subjectId\",\n         session.version_subject_id AS \"versionSubjectId\",\n         session.library_profile_pin AS \"libraryProfilePin\",\n         session.mode,\n         session.unit,\n         session.total::text AS total,\n         session.amount::text AS amount,\n         session.additional_measures AS \"additionalMeasures\",\n         session.locator,\n         session.position::text AS position,\n         session.completed_unit_count AS \"completedUnitCount\",\n         session.state,\n         session.revision,\n         session.started_at::text AS \"startedAt\",\n         session.completed_at::text AS \"completedAt\",\n         session.transaction_id AS \"transactionId\"\n  FROM library.progress_session AS session\n  CROSS JOIN args\n  WHERE session.route = args.route\n    AND session.state <> 'retired'\n    AND session.account_id = args.account_id\n    AND session.subject_id = args.subject_id\n    AND args.has_cursor AND session.started_at < args.after_started_at\n  ORDER BY session.started_at DESC, session.session_id\n  LIMIT (SELECT page_limit FROM args)\n)\nUNION ALL\n(\n  SELECT session.route,\n         session.session_id AS id,\n         session.account_id AS \"accountId\",\n         session.subject_id AS \"subjectId\",\n         session.version_subject_id AS \"versionSubjectId\",\n         session.library_profile_pin AS \"libraryProfilePin\",\n         session.mode,\n         session.unit,\n         session.total::text AS total,\n         session.amount::text AS amount,\n         session.additional_measures AS \"additionalMeasures\",\n         session.locator,\n         session.position::text AS position,\n         session.completed_unit_count AS \"completedUnitCount\",\n         session.state,\n         session.revision,\n         session.started_at::text AS \"startedAt\",\n         session.completed_at::text AS \"completedAt\",\n         session.transaction_id AS \"transactionId\"\n  FROM library.progress_session AS session\n  CROSS JOIN args\n  WHERE session.route = args.route\n    AND session.state <> 'retired'\n    AND session.account_id = args.account_id\n    AND session.subject_id = args.subject_id\n    AND args.has_cursor\n    AND session.started_at = args.after_started_at\n    AND session.session_id > args.after_session_id\n  ORDER BY session.started_at DESC, session.session_id\n  LIMIT (SELECT page_limit FROM args)\n)\n)\nSELECT * FROM candidates\nORDER BY \"startedAt\" DESC, id\nLIMIT (SELECT page_limit FROM args);";
export declare const raw: "WITH args AS NOT MATERIALIZED (\n  SELECT :route::integer AS route,\n         :account_id::uuid AS account_id,\n         :subject_id::uuid AS subject_id,\n         :after_started_at::timestamptz AS after_started_at,\n         :after_session_id::uuid AS after_session_id,\n         :has_cursor::boolean AS has_cursor,\n         :limit::integer AS page_limit\n),\ncandidates AS (\n(\n  SELECT session.route,\n         session.session_id AS id,\n         session.account_id AS \"accountId\",\n         session.subject_id AS \"subjectId\",\n         session.version_subject_id AS \"versionSubjectId\",\n         session.library_profile_pin AS \"libraryProfilePin\",\n         session.mode,\n         session.unit,\n         session.total::text AS total,\n         session.amount::text AS amount,\n         session.additional_measures AS \"additionalMeasures\",\n         session.locator,\n         session.position::text AS position,\n         session.completed_unit_count AS \"completedUnitCount\",\n         session.state,\n         session.revision,\n         session.started_at::text AS \"startedAt\",\n         session.completed_at::text AS \"completedAt\",\n         session.transaction_id AS \"transactionId\"\n  FROM library.progress_session AS session\n  CROSS JOIN args\n  WHERE session.route = args.route\n    AND session.state <> 'retired'\n    AND session.account_id = args.account_id\n    AND session.subject_id = args.subject_id\n    AND NOT args.has_cursor\n  ORDER BY session.started_at DESC, session.session_id\n  LIMIT (SELECT page_limit FROM args)\n)\nUNION ALL\n(\n  SELECT session.route,\n         session.session_id AS id,\n         session.account_id AS \"accountId\",\n         session.subject_id AS \"subjectId\",\n         session.version_subject_id AS \"versionSubjectId\",\n         session.library_profile_pin AS \"libraryProfilePin\",\n         session.mode,\n         session.unit,\n         session.total::text AS total,\n         session.amount::text AS amount,\n         session.additional_measures AS \"additionalMeasures\",\n         session.locator,\n         session.position::text AS position,\n         session.completed_unit_count AS \"completedUnitCount\",\n         session.state,\n         session.revision,\n         session.started_at::text AS \"startedAt\",\n         session.completed_at::text AS \"completedAt\",\n         session.transaction_id AS \"transactionId\"\n  FROM library.progress_session AS session\n  CROSS JOIN args\n  WHERE session.route = args.route\n    AND session.state <> 'retired'\n    AND session.account_id = args.account_id\n    AND session.subject_id = args.subject_id\n    AND args.has_cursor AND session.started_at < args.after_started_at\n  ORDER BY session.started_at DESC, session.session_id\n  LIMIT (SELECT page_limit FROM args)\n)\nUNION ALL\n(\n  SELECT session.route,\n         session.session_id AS id,\n         session.account_id AS \"accountId\",\n         session.subject_id AS \"subjectId\",\n         session.version_subject_id AS \"versionSubjectId\",\n         session.library_profile_pin AS \"libraryProfilePin\",\n         session.mode,\n         session.unit,\n         session.total::text AS total,\n         session.amount::text AS amount,\n         session.additional_measures AS \"additionalMeasures\",\n         session.locator,\n         session.position::text AS position,\n         session.completed_unit_count AS \"completedUnitCount\",\n         session.state,\n         session.revision,\n         session.started_at::text AS \"startedAt\",\n         session.completed_at::text AS \"completedAt\",\n         session.transaction_id AS \"transactionId\"\n  FROM library.progress_session AS session\n  CROSS JOIN args\n  WHERE session.route = args.route\n    AND session.state <> 'retired'\n    AND session.account_id = args.account_id\n    AND session.subject_id = args.subject_id\n    AND args.has_cursor\n    AND session.started_at = args.after_started_at\n    AND session.session_id > args.after_session_id\n  ORDER BY session.started_at DESC, session.session_id\n  LIMIT (SELECT page_limit FROM args)\n)\n)\nSELECT * FROM candidates\nORDER BY \"startedAt\" DESC, id\nLIMIT (SELECT page_limit FROM args);\n";
export declare const params: readonly ["route", "account_id", "subject_id", "after_started_at", "after_session_id", "has_cursor", "limit"];
/**
 * ```sql
 * WITH args AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route,
 *          :account_id::uuid AS account_id,
 *          :subject_id::uuid AS subject_id,
 *          :after_started_at::timestamptz AS after_started_at,
 *          :after_session_id::uuid AS after_session_id,
 *          :has_cursor::boolean AS has_cursor,
 *          :limit::integer AS page_limit
 * ),
 * candidates AS (
 * (
 *   SELECT session.route,
 *          session.session_id AS id,
 *          session.account_id AS "accountId",
 *          session.subject_id AS "subjectId",
 *          session.version_subject_id AS "versionSubjectId",
 *          session.library_profile_pin AS "libraryProfilePin",
 *          session.mode,
 *          session.unit,
 *          session.total::text AS total,
 *          session.amount::text AS amount,
 *          session.additional_measures AS "additionalMeasures",
 *          session.locator,
 *          session.position::text AS position,
 *          session.completed_unit_count AS "completedUnitCount",
 *          session.state,
 *          session.revision,
 *          session.started_at::text AS "startedAt",
 *          session.completed_at::text AS "completedAt",
 *          session.transaction_id AS "transactionId"
 *   FROM library.progress_session AS session
 *   CROSS JOIN args
 *   WHERE session.route = args.route
 *     AND session.state <> 'retired'
 *     AND session.account_id = args.account_id
 *     AND session.subject_id = args.subject_id
 *     AND NOT args.has_cursor
 *   ORDER BY session.started_at DESC, session.session_id
 *   LIMIT (SELECT page_limit FROM args)
 * )
 * UNION ALL
 * (
 *   SELECT session.route,
 *          session.session_id AS id,
 *          session.account_id AS "accountId",
 *          session.subject_id AS "subjectId",
 *          session.version_subject_id AS "versionSubjectId",
 *          session.library_profile_pin AS "libraryProfilePin",
 *          session.mode,
 *          session.unit,
 *          session.total::text AS total,
 *          session.amount::text AS amount,
 *          session.additional_measures AS "additionalMeasures",
 *          session.locator,
 *          session.position::text AS position,
 *          session.completed_unit_count AS "completedUnitCount",
 *          session.state,
 *          session.revision,
 *          session.started_at::text AS "startedAt",
 *          session.completed_at::text AS "completedAt",
 *          session.transaction_id AS "transactionId"
 *   FROM library.progress_session AS session
 *   CROSS JOIN args
 *   WHERE session.route = args.route
 *     AND session.state <> 'retired'
 *     AND session.account_id = args.account_id
 *     AND session.subject_id = args.subject_id
 *     AND args.has_cursor AND session.started_at < args.after_started_at
 *   ORDER BY session.started_at DESC, session.session_id
 *   LIMIT (SELECT page_limit FROM args)
 * )
 * UNION ALL
 * (
 *   SELECT session.route,
 *          session.session_id AS id,
 *          session.account_id AS "accountId",
 *          session.subject_id AS "subjectId",
 *          session.version_subject_id AS "versionSubjectId",
 *          session.library_profile_pin AS "libraryProfilePin",
 *          session.mode,
 *          session.unit,
 *          session.total::text AS total,
 *          session.amount::text AS amount,
 *          session.additional_measures AS "additionalMeasures",
 *          session.locator,
 *          session.position::text AS position,
 *          session.completed_unit_count AS "completedUnitCount",
 *          session.state,
 *          session.revision,
 *          session.started_at::text AS "startedAt",
 *          session.completed_at::text AS "completedAt",
 *          session.transaction_id AS "transactionId"
 *   FROM library.progress_session AS session
 *   CROSS JOIN args
 *   WHERE session.route = args.route
 *     AND session.state <> 'retired'
 *     AND session.account_id = args.account_id
 *     AND session.subject_id = args.subject_id
 *     AND args.has_cursor
 *     AND session.started_at = args.after_started_at
 *     AND session.session_id > args.after_session_id
 *   ORDER BY session.started_at DESC, session.session_id
 *   LIMIT (SELECT page_limit FROM args)
 * )
 * )
 * SELECT * FROM candidates
 * ORDER BY "startedAt" DESC, id
 * LIMIT (SELECT page_limit FROM args);
 * ```
 */
declare const query: Query<{
    route: number;
    account_id: string;
    subject_id: string;
    after_started_at: string;
    after_session_id: string;
    has_cursor: boolean;
    limit: number;
}, {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
    versionSubjectId: string | null;
    libraryProfilePin: Json;
    mode: string;
    unit: string;
    total: string | null;
    amount: string | null;
    additionalMeasures: Json;
    locator: string | null;
    position: string | null;
    completedUnitCount: number;
    state: string;
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
