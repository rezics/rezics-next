import type { Query } from "reylo";
export type Params = {
    route: number;
    account_id: string;
};
export type Row = {
    generation: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT COALESCE(\n  (SELECT generation::text FROM library.progress_discovery_generation\n   WHERE route = $1::integer AND account_id = $2::uuid),\n  '0'\n) AS generation;";
export declare const raw: "SELECT COALESCE(\n  (SELECT generation::text FROM library.progress_discovery_generation\n   WHERE route = :route::integer AND account_id = :account_id::uuid),\n  '0'\n) AS generation;\n";
export declare const params: readonly ["route", "account_id"];
/**
 * ```sql
 * SELECT COALESCE(
 *   (SELECT generation::text FROM library.progress_discovery_generation
 *    WHERE route = :route::integer AND account_id = :account_id::uuid),
 *   '0'
 * ) AS generation;
 * ```
 */
declare const query: Query<{
    route: number;
    account_id: string;
}, {
    generation: string;
}, "one", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
