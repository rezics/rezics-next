import type { Json, Query } from "reylo";
export type Params = {
    amount?: string | null;
    locator?: string | null;
    position?: string | null;
    additional_measures: Json;
    completed_unit_count: number;
    state: "active" | "completed" | "abandoned" | "retired";
    completed_at?: string | null;
    time: string;
    transaction_id: string;
    route: number;
    session_id: string;
    revision: number;
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
export declare const sql: "UPDATE library.progress_session\nSET amount = $1::numeric,\n    locator = $2::text,\n    position = $3::numeric,\n    additional_measures = $4::jsonb,\n    completed_unit_count = $5,\n    state = $6,\n    completed_at = $7::timestamptz,\n    last_changed_at = GREATEST(last_changed_at, $8::timestamptz),\n    revision = revision + 1,\n    transaction_id = $9\nWHERE route = $10 AND session_id = $11 AND revision = $12\nRETURNING route, session_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\",\n          version_subject_id AS \"versionSubjectId\", mode, unit, total::text AS total, amount::text AS amount, locator,\n          position::text AS position, completed_unit_count AS \"completedUnitCount\", state, revision,\n          started_at::text AS \"startedAt\", completed_at::text AS \"completedAt\", transaction_id AS \"transactionId\",\n          additional_measures AS \"additionalMeasures\";";
export declare const raw: "UPDATE library.progress_session\nSET amount = :amount::nullable(numeric),\n    locator = :locator::nullable(text),\n    position = :position::nullable(numeric),\n    additional_measures = :additional_measures::jsonb,\n    completed_unit_count = :completed_unit_count,\n    state = :state,\n    completed_at = :completed_at::nullable(timestamptz),\n    last_changed_at = GREATEST(last_changed_at, :time::timestamptz),\n    revision = revision + 1,\n    transaction_id = :transaction_id\nWHERE route = :route AND session_id = :session_id AND revision = :revision\nRETURNING route, session_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\",\n          version_subject_id AS \"versionSubjectId\", mode, unit, total::text AS total, amount::text AS amount, locator,\n          position::text AS position, completed_unit_count AS \"completedUnitCount\", state, revision,\n          started_at::text AS \"startedAt\", completed_at::text AS \"completedAt\", transaction_id AS \"transactionId\",\n          additional_measures AS \"additionalMeasures\";\n";
export declare const params: readonly ["amount", "locator", "position", "additional_measures", "completed_unit_count", "state", "completed_at", "time", "transaction_id", "route", "session_id", "revision"];
/**
 * ```sql
 * UPDATE library.progress_session
 * SET amount = :amount::nullable(numeric),
 *     locator = :locator::nullable(text),
 *     position = :position::nullable(numeric),
 *     additional_measures = :additional_measures::jsonb,
 *     completed_unit_count = :completed_unit_count,
 *     state = :state,
 *     completed_at = :completed_at::nullable(timestamptz),
 *     last_changed_at = GREATEST(last_changed_at, :time::timestamptz),
 *     revision = revision + 1,
 *     transaction_id = :transaction_id
 * WHERE route = :route AND session_id = :session_id AND revision = :revision
 * RETURNING route, session_id AS id, account_id AS "accountId", subject_id AS "subjectId",
 *           version_subject_id AS "versionSubjectId", mode, unit, total::text AS total, amount::text AS amount, locator,
 *           position::text AS position, completed_unit_count AS "completedUnitCount", state, revision,
 *           started_at::text AS "startedAt", completed_at::text AS "completedAt", transaction_id AS "transactionId",
 *           additional_measures AS "additionalMeasures";
 * ```
 */
declare const query: Query<{
    amount?: string | null;
    locator?: string | null;
    position?: string | null;
    additional_measures: Json;
    completed_unit_count: number;
    state: "active" | "completed" | "abandoned" | "retired";
    completed_at?: string | null;
    time: string;
    transaction_id: string;
    route: number;
    session_id: string;
    revision: number;
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
