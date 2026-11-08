import type { Query } from "reylo";
export type Params = {
    route: number;
    session_id: string;
    unit_ids: string[];
};
export type Row = {
    removed: number;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "WITH removed AS (\n  DELETE FROM library.progress_unit\n  WHERE route = $1 AND session_id = $2 AND unit_id = ANY($3::text[])\n  RETURNING 1\n)\nSELECT count(*)::integer AS removed FROM removed;";
export declare const raw: "WITH removed AS (\n  DELETE FROM library.progress_unit\n  WHERE route = :route AND session_id = :session_id AND unit_id = ANY(:unit_ids::text[])\n  RETURNING 1\n)\nSELECT count(*)::integer AS removed FROM removed;\n";
export declare const params: readonly ["route", "session_id", "unit_ids"];
/**
 * ```sql
 * WITH removed AS (
 *   DELETE FROM library.progress_unit
 *   WHERE route = :route AND session_id = :session_id AND unit_id = ANY(:unit_ids::text[])
 *   RETURNING 1
 * )
 * SELECT count(*)::integer AS removed FROM removed;
 * ```
 */
declare const query: Query<{
    route: number;
    session_id: string;
    unit_ids: string[];
}, {
    removed: number;
}, "one", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
