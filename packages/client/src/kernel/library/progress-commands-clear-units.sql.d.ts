import type { Query } from "reylo";
export type Params = {
    route: number;
    session_id: string;
};
export type Row = never;
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "-- One exact session, bounded by the native 20000-key session cap; no history scan.\nDELETE FROM library.progress_unit\nWHERE route = $1 AND session_id = $2;";
export declare const raw: "-- One exact session, bounded by the native 20000-key session cap; no history scan.\nDELETE FROM library.progress_unit\nWHERE route = :route AND session_id = :session_id;\n";
export declare const params: readonly ["route", "session_id"];
/**
 * One exact session, bounded by the native 20000-key session cap; no history scan.
 *
 * ```sql
 * DELETE FROM library.progress_unit
 * WHERE route = :route AND session_id = :session_id;
 * ```
 */
declare const query: Query<{
    route: number;
    session_id: string;
}, never, "none", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
