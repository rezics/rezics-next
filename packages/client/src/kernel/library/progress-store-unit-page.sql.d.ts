import type { Query } from "reylo";
export type Params = {
    route: number;
    session_id: string;
    after_unit_id: string;
    has_cursor: boolean;
    limit: number;
};
export type Row = {
    route: number;
    sessionId: string;
    unitId: string;
    addedAt: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "WITH args AS NOT MATERIALIZED (\n  SELECT $1::integer AS route,\n         $2::uuid AS session_id,\n         $3::text AS after_unit_id,\n         $4::boolean AS has_cursor,\n         $5::integer AS page_limit\n)\nSELECT unit.route,\n       unit.session_id AS \"sessionId\",\n       unit.unit_id AS \"unitId\",\n       unit.added_at::text AS \"addedAt\"\nFROM library.progress_unit AS unit\nCROSS JOIN args\nWHERE unit.route = args.route\n  AND unit.session_id = args.session_id\n  AND (NOT args.has_cursor OR unit.unit_id > args.after_unit_id)\nORDER BY unit.unit_id\nLIMIT (SELECT page_limit FROM args);";
export declare const raw: "WITH args AS NOT MATERIALIZED (\n  SELECT :route::integer AS route,\n         :session_id::uuid AS session_id,\n         :after_unit_id::text AS after_unit_id,\n         :has_cursor::boolean AS has_cursor,\n         :limit::integer AS page_limit\n)\nSELECT unit.route,\n       unit.session_id AS \"sessionId\",\n       unit.unit_id AS \"unitId\",\n       unit.added_at::text AS \"addedAt\"\nFROM library.progress_unit AS unit\nCROSS JOIN args\nWHERE unit.route = args.route\n  AND unit.session_id = args.session_id\n  AND (NOT args.has_cursor OR unit.unit_id > args.after_unit_id)\nORDER BY unit.unit_id\nLIMIT (SELECT page_limit FROM args);\n";
export declare const params: readonly ["route", "session_id", "after_unit_id", "has_cursor", "limit"];
/**
 * ```sql
 * WITH args AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route,
 *          :session_id::uuid AS session_id,
 *          :after_unit_id::text AS after_unit_id,
 *          :has_cursor::boolean AS has_cursor,
 *          :limit::integer AS page_limit
 * )
 * SELECT unit.route,
 *        unit.session_id AS "sessionId",
 *        unit.unit_id AS "unitId",
 *        unit.added_at::text AS "addedAt"
 * FROM library.progress_unit AS unit
 * CROSS JOIN args
 * WHERE unit.route = args.route
 *   AND unit.session_id = args.session_id
 *   AND (NOT args.has_cursor OR unit.unit_id > args.after_unit_id)
 * ORDER BY unit.unit_id
 * LIMIT (SELECT page_limit FROM args);
 * ```
 */
declare const query: Query<{
    route: number;
    session_id: string;
    after_unit_id: string;
    has_cursor: boolean;
    limit: number;
}, {
    route: number;
    sessionId: string;
    unitId: string;
    addedAt: string;
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
