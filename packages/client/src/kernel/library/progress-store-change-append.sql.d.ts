import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    session_id: string;
    change_no: number;
    intent: Json;
    time: string;
    transaction_id: string;
};
export type Row = {
    route: number;
    sessionId: string;
    changeNo: number;
    intent: Json;
    recordedAt: string;
    transactionId: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "INSERT INTO library.progress_change\n  (route, session_id, change_no, intent, recorded_at, transaction_id)\nVALUES\n  ($1, $2, $3, $4::jsonb, $5::timestamptz, $6)\nRETURNING route, session_id AS \"sessionId\", change_no AS \"changeNo\", intent, recorded_at::text AS \"recordedAt\",\n          transaction_id AS \"transactionId\";";
export declare const raw: "INSERT INTO library.progress_change\n  (route, session_id, change_no, intent, recorded_at, transaction_id)\nVALUES\n  (:route, :session_id, :change_no, :intent::jsonb, :time::timestamptz, :transaction_id)\nRETURNING route, session_id AS \"sessionId\", change_no AS \"changeNo\", intent, recorded_at::text AS \"recordedAt\",\n          transaction_id AS \"transactionId\";\n";
export declare const params: readonly ["route", "session_id", "change_no", "intent", "time", "transaction_id"];
/**
 * ```sql
 * INSERT INTO library.progress_change
 *   (route, session_id, change_no, intent, recorded_at, transaction_id)
 * VALUES
 *   (:route, :session_id, :change_no, :intent::jsonb, :time::timestamptz, :transaction_id)
 * RETURNING route, session_id AS "sessionId", change_no AS "changeNo", intent, recorded_at::text AS "recordedAt",
 *           transaction_id AS "transactionId";
 * ```
 */
declare const query: Query<{
    route: number;
    session_id: string;
    change_no: number;
    intent: Json;
    time: string;
    transaction_id: string;
}, {
    route: number;
    sessionId: string;
    changeNo: number;
    intent: Json;
    recordedAt: string;
    transactionId: string;
}, "one", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
