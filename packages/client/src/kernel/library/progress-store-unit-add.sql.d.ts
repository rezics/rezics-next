import type { Query } from "reylo";
export type Params = {
    route: number;
    session_id: string;
    time: string;
    unit_ids: string[];
};
export type Row = {
    added: number;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "WITH input AS NOT MATERIALIZED (\n  SELECT $1::integer AS route,\n         $2::uuid AS session_id,\n         $3::timestamptz AS added_at,\n         $4::text[] AS unit_ids\n),\npresent AS (\n  SELECT session.route, session.session_id\n  FROM library.progress_session AS session\n  CROSS JOIN input\n  WHERE session.route = input.route AND session.session_id = input.session_id\n),\ninserted AS (\n  INSERT INTO library.progress_unit (route, session_id, unit_id, added_at)\n  SELECT input.route, present.session_id, unit.unit_id, input.added_at\n  FROM present\n  CROSS JOIN input\n  CROSS JOIN LATERAL (\n    SELECT DISTINCT listed.unit_id FROM unnest(input.unit_ids) AS listed(unit_id)\n  ) AS unit\n  ON CONFLICT (route, session_id, unit_id) DO NOTHING\n  RETURNING 1\n)\nSELECT count(*)::integer AS added FROM inserted;";
export declare const raw: "WITH input AS NOT MATERIALIZED (\n  SELECT :route::integer AS route,\n         :session_id::uuid AS session_id,\n         :time::timestamptz AS added_at,\n         :unit_ids::text[] AS unit_ids\n),\npresent AS (\n  SELECT session.route, session.session_id\n  FROM library.progress_session AS session\n  CROSS JOIN input\n  WHERE session.route = input.route AND session.session_id = input.session_id\n),\ninserted AS (\n  INSERT INTO library.progress_unit (route, session_id, unit_id, added_at)\n  SELECT input.route, present.session_id, unit.unit_id, input.added_at\n  FROM present\n  CROSS JOIN input\n  CROSS JOIN LATERAL (\n    SELECT DISTINCT listed.unit_id FROM unnest(input.unit_ids) AS listed(unit_id)\n  ) AS unit\n  ON CONFLICT (route, session_id, unit_id) DO NOTHING\n  RETURNING 1\n)\nSELECT count(*)::integer AS added FROM inserted;\n";
export declare const params: readonly ["route", "session_id", "time", "unit_ids"];
/**
 * ```sql
 * WITH input AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route,
 *          :session_id::uuid AS session_id,
 *          :time::timestamptz AS added_at,
 *          :unit_ids::text[] AS unit_ids
 * ),
 * present AS (
 *   SELECT session.route, session.session_id
 *   FROM library.progress_session AS session
 *   CROSS JOIN input
 *   WHERE session.route = input.route AND session.session_id = input.session_id
 * ),
 * inserted AS (
 *   INSERT INTO library.progress_unit (route, session_id, unit_id, added_at)
 *   SELECT input.route, present.session_id, unit.unit_id, input.added_at
 *   FROM present
 *   CROSS JOIN input
 *   CROSS JOIN LATERAL (
 *     SELECT DISTINCT listed.unit_id FROM unnest(input.unit_ids) AS listed(unit_id)
 *   ) AS unit
 *   ON CONFLICT (route, session_id, unit_id) DO NOTHING
 *   RETURNING 1
 * )
 * SELECT count(*)::integer AS added FROM inserted;
 * ```
 */
declare const query: Query<{
    route: number;
    session_id: string;
    time: string;
    unit_ids: string[];
}, {
    added: number;
}, "one", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
