import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    session_id: string;
    account_id: string;
    subject_id: string;
    version_subject_id?: string | null;
    mode: "scalar_amount" | "cursor_position" | "completed_units";
    unit: string;
    total?: string | null;
    time: string;
    last_changed_at: string;
    transaction_id: string;
    library_profile_pin?: Json;
    additional_measures: Json;
};
export type Row = {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
    versionSubjectId: string | null;
    mode: "scalar_amount" | "cursor_position" | "completed_units";
    unit: string;
    total: string | null;
    amount: string | null;
    locator: string | null;
    position: string | null;
    completedUnitCount: number;
    state: "active" | "completed" | "abandoned" | "retired";
    revision: number;
    startedAt: string;
    completedAt: string | null;
    transactionId: string;
    additionalMeasures: Json;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "INSERT INTO library.progress_session\n  (route, session_id, account_id, subject_id, version_subject_id, mode, unit, total, amount, locator, position,\n   completed_unit_count, state, revision, started_at, last_changed_at, completed_at, transaction_id,\n   library_profile_pin, additional_measures)\nVALUES\n  ($1, $2, $3, $4, $5::uuid, $6, $7,\n   $8::numeric, NULL, NULL, NULL, 0, 'active', 1, $9::timestamptz, $10::timestamptz,\n   NULL, $11, $12::jsonb, $13::jsonb)\nRETURNING route, session_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\",\n          version_subject_id AS \"versionSubjectId\", mode, unit, total::text AS total, amount::text AS amount, locator,\n          position::text AS position, completed_unit_count AS \"completedUnitCount\", state, revision,\n          started_at::text AS \"startedAt\", completed_at::text AS \"completedAt\", transaction_id AS \"transactionId\",\n          additional_measures AS \"additionalMeasures\";";
export declare const raw: "INSERT INTO library.progress_session\n  (route, session_id, account_id, subject_id, version_subject_id, mode, unit, total, amount, locator, position,\n   completed_unit_count, state, revision, started_at, last_changed_at, completed_at, transaction_id,\n   library_profile_pin, additional_measures)\nVALUES\n  (:route, :session_id, :account_id, :subject_id, :version_subject_id::nullable(uuid), :mode, :unit,\n   :total::nullable(numeric), NULL, NULL, NULL, 0, 'active', 1, :time::timestamptz, :last_changed_at::timestamptz,\n   NULL, :transaction_id, :library_profile_pin::nullable(jsonb), :additional_measures::jsonb)\nRETURNING route, session_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\",\n          version_subject_id AS \"versionSubjectId\", mode, unit, total::text AS total, amount::text AS amount, locator,\n          position::text AS position, completed_unit_count AS \"completedUnitCount\", state, revision,\n          started_at::text AS \"startedAt\", completed_at::text AS \"completedAt\", transaction_id AS \"transactionId\",\n          additional_measures AS \"additionalMeasures\";\n";
export declare const params: readonly ["route", "session_id", "account_id", "subject_id", "version_subject_id", "mode", "unit", "total", "time", "last_changed_at", "transaction_id", "library_profile_pin", "additional_measures"];
/**
 * ```sql
 * INSERT INTO library.progress_session
 *   (route, session_id, account_id, subject_id, version_subject_id, mode, unit, total, amount, locator, position,
 *    completed_unit_count, state, revision, started_at, last_changed_at, completed_at, transaction_id,
 *    library_profile_pin, additional_measures)
 * VALUES
 *   (:route, :session_id, :account_id, :subject_id, :version_subject_id::nullable(uuid), :mode, :unit,
 *    :total::nullable(numeric), NULL, NULL, NULL, 0, 'active', 1, :time::timestamptz, :last_changed_at::timestamptz,
 *    NULL, :transaction_id, :library_profile_pin::nullable(jsonb), :additional_measures::jsonb)
 * RETURNING route, session_id AS id, account_id AS "accountId", subject_id AS "subjectId",
 *           version_subject_id AS "versionSubjectId", mode, unit, total::text AS total, amount::text AS amount, locator,
 *           position::text AS position, completed_unit_count AS "completedUnitCount", state, revision,
 *           started_at::text AS "startedAt", completed_at::text AS "completedAt", transaction_id AS "transactionId",
 *           additional_measures AS "additionalMeasures";
 * ```
 */
declare const query: Query<{
    route: number;
    session_id: string;
    account_id: string;
    subject_id: string;
    version_subject_id?: string | null;
    mode: "scalar_amount" | "cursor_position" | "completed_units";
    unit: string;
    total?: string | null;
    time: string;
    last_changed_at: string;
    transaction_id: string;
    library_profile_pin?: Json;
    additional_measures: Json;
}, {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
    versionSubjectId: string | null;
    mode: "scalar_amount" | "cursor_position" | "completed_units";
    unit: string;
    total: string | null;
    amount: string | null;
    locator: string | null;
    position: string | null;
    completedUnitCount: number;
    state: "active" | "completed" | "abandoned" | "retired";
    revision: number;
    startedAt: string;
    completedAt: string | null;
    transactionId: string;
    additionalMeasures: Json;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
