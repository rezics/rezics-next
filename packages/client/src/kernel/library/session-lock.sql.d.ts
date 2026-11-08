import type { Query } from "reylo";
export type Params = {
    route: number;
    session_id: string;
};
export type Row = {
    session_id: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT session_id\nFROM library.progress_session\nWHERE route = $1 AND session_id = $2\nFOR UPDATE;";
export declare const raw: "SELECT session_id\nFROM library.progress_session\nWHERE route = :route AND session_id = :session_id\nFOR UPDATE;\n";
export declare const params: readonly ["route", "session_id"];
/**
 * ```sql
 * SELECT session_id
 * FROM library.progress_session
 * WHERE route = :route AND session_id = :session_id
 * FOR UPDATE;
 * ```
 */
declare const query: Query<{
    route: number;
    session_id: string;
}, {
    session_id: string;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
