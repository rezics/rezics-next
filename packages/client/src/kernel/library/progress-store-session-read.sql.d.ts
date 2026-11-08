import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    session_id: string;
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
    libraryProfilePin: Json;
    additionalMeasures: Json;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT route, session_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\",\n       version_subject_id AS \"versionSubjectId\", mode, unit, total::text AS total, amount::text AS amount, locator,\n       position::text AS position, completed_unit_count AS \"completedUnitCount\", state, revision,\n       started_at::text AS \"startedAt\", completed_at::text AS \"completedAt\", transaction_id AS \"transactionId\",\n       library_profile_pin AS \"libraryProfilePin\", additional_measures AS \"additionalMeasures\"\nFROM library.progress_session\nWHERE state <> 'retired' AND route = $1 AND session_id = $2;";
export declare const raw: "SELECT route, session_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\",\n       version_subject_id AS \"versionSubjectId\", mode, unit, total::text AS total, amount::text AS amount, locator,\n       position::text AS position, completed_unit_count AS \"completedUnitCount\", state, revision,\n       started_at::text AS \"startedAt\", completed_at::text AS \"completedAt\", transaction_id AS \"transactionId\",\n       library_profile_pin AS \"libraryProfilePin\", additional_measures AS \"additionalMeasures\"\nFROM library.progress_session\nWHERE state <> 'retired' AND route = :route AND session_id = :session_id;\n";
export declare const params: readonly ["route", "session_id"];
/**
 * ```sql
 * SELECT route, session_id AS id, account_id AS "accountId", subject_id AS "subjectId",
 *        version_subject_id AS "versionSubjectId", mode, unit, total::text AS total, amount::text AS amount, locator,
 *        position::text AS position, completed_unit_count AS "completedUnitCount", state, revision,
 *        started_at::text AS "startedAt", completed_at::text AS "completedAt", transaction_id AS "transactionId",
 *        library_profile_pin AS "libraryProfilePin", additional_measures AS "additionalMeasures"
 * FROM library.progress_session
 * WHERE state <> 'retired' AND route = :route AND session_id = :session_id;
 * ```
 */
declare const query: Query<{
    route: number;
    session_id: string;
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
    libraryProfilePin: Json;
    additionalMeasures: Json;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
