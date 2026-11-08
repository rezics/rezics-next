import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    session_id: string;
    after_change_no: number;
    has_cursor: boolean;
    limit: number;
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
export declare const sql: "WITH args AS NOT MATERIALIZED (\n  SELECT $1::integer AS route,\n         $2::uuid AS session_id,\n         $3::integer AS after_change_no,\n         $4::boolean AS has_cursor,\n         $5::integer AS page_limit\n)\nSELECT change.route,\n       change.session_id AS \"sessionId\",\n       change.change_no AS \"changeNo\",\n       change.intent,\n       change.recorded_at::text AS \"recordedAt\",\n       change.transaction_id AS \"transactionId\"\nFROM library.progress_change AS change\nCROSS JOIN args\nWHERE change.route = args.route\n  AND change.session_id = args.session_id\n  AND (NOT args.has_cursor OR change.change_no > args.after_change_no)\nORDER BY change.change_no\nLIMIT (SELECT page_limit FROM args);";
export declare const raw: "WITH args AS NOT MATERIALIZED (\n  SELECT :route::integer AS route,\n         :session_id::uuid AS session_id,\n         :after_change_no::integer AS after_change_no,\n         :has_cursor::boolean AS has_cursor,\n         :limit::integer AS page_limit\n)\nSELECT change.route,\n       change.session_id AS \"sessionId\",\n       change.change_no AS \"changeNo\",\n       change.intent,\n       change.recorded_at::text AS \"recordedAt\",\n       change.transaction_id AS \"transactionId\"\nFROM library.progress_change AS change\nCROSS JOIN args\nWHERE change.route = args.route\n  AND change.session_id = args.session_id\n  AND (NOT args.has_cursor OR change.change_no > args.after_change_no)\nORDER BY change.change_no\nLIMIT (SELECT page_limit FROM args);\n";
export declare const params: readonly ["route", "session_id", "after_change_no", "has_cursor", "limit"];
/**
 * ```sql
 * WITH args AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route,
 *          :session_id::uuid AS session_id,
 *          :after_change_no::integer AS after_change_no,
 *          :has_cursor::boolean AS has_cursor,
 *          :limit::integer AS page_limit
 * )
 * SELECT change.route,
 *        change.session_id AS "sessionId",
 *        change.change_no AS "changeNo",
 *        change.intent,
 *        change.recorded_at::text AS "recordedAt",
 *        change.transaction_id AS "transactionId"
 * FROM library.progress_change AS change
 * CROSS JOIN args
 * WHERE change.route = args.route
 *   AND change.session_id = args.session_id
 *   AND (NOT args.has_cursor OR change.change_no > args.after_change_no)
 * ORDER BY change.change_no
 * LIMIT (SELECT page_limit FROM args);
 * ```
 */
declare const query: Query<{
    route: number;
    session_id: string;
    after_change_no: number;
    has_cursor: boolean;
    limit: number;
}, {
    route: number;
    sessionId: string;
    changeNo: number;
    intent: Json;
    recordedAt: string;
    transactionId: string;
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
