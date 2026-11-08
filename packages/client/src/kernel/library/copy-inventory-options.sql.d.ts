import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    account_id: string;
    limit: number;
};
export type Row = {
    dimension: string;
    id: string;
    copyId: string | null;
    copyKind: string | null;
    profilePin: Json;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "WITH RECURSIVE\ninput AS (\n  SELECT $1::integer AS route, $2::uuid AS account_id, $3::integer AS max_options\n),\nkind_seed AS (\n  SELECT copy.kind AS id,\n         copy.copy_id AS \"copyId\",\n         copy.kind AS \"copyKind\",\n         copy.kind_profile_pin AS \"profilePin\",\n         1 AS ordinal\n  FROM library.copy AS copy\n  CROSS JOIN input AS parameters\n  WHERE copy.route = parameters.route\n    AND copy.account_id = parameters.account_id\n    AND copy.deletion_id IS NULL\n    AND copy.kind IS NOT NULL\n  ORDER BY copy.kind, copy.created_at, copy.copy_id\n  LIMIT 1\n),\nkind_choices AS (\n  SELECT * FROM kind_seed\n  UNION ALL\n  SELECT next.id, next.\"copyId\", next.\"copyKind\", next.\"profilePin\", previous.ordinal + 1\n  FROM kind_choices AS previous\n  CROSS JOIN input AS parameters\n  CROSS JOIN LATERAL (\n    SELECT copy.kind AS id,\n           copy.copy_id AS \"copyId\",\n           copy.kind AS \"copyKind\",\n           copy.kind_profile_pin AS \"profilePin\"\n    FROM library.copy AS copy\n    WHERE copy.route = parameters.route\n      AND copy.account_id = parameters.account_id\n      AND copy.deletion_id IS NULL\n      AND copy.kind IS NOT NULL\n      AND copy.kind > previous.id\n    ORDER BY copy.kind, copy.created_at, copy.copy_id\n    LIMIT 1\n  ) AS next\n  WHERE previous.ordinal < parameters.max_options\n),\nstatus_seed AS (\n  SELECT copy.status AS id,\n         copy.copy_id AS \"copyId\",\n         copy.kind AS \"copyKind\",\n         COALESCE(copy.status_profile_pin, copy.library_profile_pin) AS \"profilePin\",\n         1 AS ordinal\n  FROM library.copy AS copy\n  CROSS JOIN input AS parameters\n  WHERE copy.route = parameters.route\n    AND copy.account_id = parameters.account_id\n    AND copy.deletion_id IS NULL\n  ORDER BY copy.status, copy.created_at, copy.copy_id\n  LIMIT 1\n),\nstatus_choices AS (\n  SELECT * FROM status_seed\n  UNION ALL\n  SELECT next.id, next.\"copyId\", next.\"copyKind\", next.\"profilePin\", previous.ordinal + 1\n  FROM status_choices AS previous\n  CROSS JOIN input AS parameters\n  CROSS JOIN LATERAL (\n    SELECT copy.status AS id,\n           copy.copy_id AS \"copyId\",\n           copy.kind AS \"copyKind\",\n           COALESCE(copy.status_profile_pin, copy.library_profile_pin) AS \"profilePin\"\n    FROM library.copy AS copy\n    WHERE copy.route = parameters.route\n      AND copy.account_id = parameters.account_id\n      AND copy.deletion_id IS NULL\n      AND copy.status > previous.id\n    ORDER BY copy.status, copy.created_at, copy.copy_id\n    LIMIT 1\n  ) AS next\n  WHERE previous.ordinal < parameters.max_options\n)\nSELECT 'kind'::text AS dimension, id, \"copyId\", \"copyKind\", \"profilePin\"\nFROM kind_choices\nUNION ALL\nSELECT 'status'::text AS dimension, id, \"copyId\", \"copyKind\", \"profilePin\"\nFROM status_choices\nORDER BY dimension, id;";
export declare const raw: "WITH RECURSIVE\ninput AS (\n  SELECT :route::integer AS route, :account_id::uuid AS account_id, :limit::integer AS max_options\n),\nkind_seed AS (\n  SELECT copy.kind AS id,\n         copy.copy_id AS \"copyId\",\n         copy.kind AS \"copyKind\",\n         copy.kind_profile_pin AS \"profilePin\",\n         1 AS ordinal\n  FROM library.copy AS copy\n  CROSS JOIN input AS parameters\n  WHERE copy.route = parameters.route\n    AND copy.account_id = parameters.account_id\n    AND copy.deletion_id IS NULL\n    AND copy.kind IS NOT NULL\n  ORDER BY copy.kind, copy.created_at, copy.copy_id\n  LIMIT 1\n),\nkind_choices AS (\n  SELECT * FROM kind_seed\n  UNION ALL\n  SELECT next.id, next.\"copyId\", next.\"copyKind\", next.\"profilePin\", previous.ordinal + 1\n  FROM kind_choices AS previous\n  CROSS JOIN input AS parameters\n  CROSS JOIN LATERAL (\n    SELECT copy.kind AS id,\n           copy.copy_id AS \"copyId\",\n           copy.kind AS \"copyKind\",\n           copy.kind_profile_pin AS \"profilePin\"\n    FROM library.copy AS copy\n    WHERE copy.route = parameters.route\n      AND copy.account_id = parameters.account_id\n      AND copy.deletion_id IS NULL\n      AND copy.kind IS NOT NULL\n      AND copy.kind > previous.id\n    ORDER BY copy.kind, copy.created_at, copy.copy_id\n    LIMIT 1\n  ) AS next\n  WHERE previous.ordinal < parameters.max_options\n),\nstatus_seed AS (\n  SELECT copy.status AS id,\n         copy.copy_id AS \"copyId\",\n         copy.kind AS \"copyKind\",\n         COALESCE(copy.status_profile_pin, copy.library_profile_pin) AS \"profilePin\",\n         1 AS ordinal\n  FROM library.copy AS copy\n  CROSS JOIN input AS parameters\n  WHERE copy.route = parameters.route\n    AND copy.account_id = parameters.account_id\n    AND copy.deletion_id IS NULL\n  ORDER BY copy.status, copy.created_at, copy.copy_id\n  LIMIT 1\n),\nstatus_choices AS (\n  SELECT * FROM status_seed\n  UNION ALL\n  SELECT next.id, next.\"copyId\", next.\"copyKind\", next.\"profilePin\", previous.ordinal + 1\n  FROM status_choices AS previous\n  CROSS JOIN input AS parameters\n  CROSS JOIN LATERAL (\n    SELECT copy.status AS id,\n           copy.copy_id AS \"copyId\",\n           copy.kind AS \"copyKind\",\n           COALESCE(copy.status_profile_pin, copy.library_profile_pin) AS \"profilePin\"\n    FROM library.copy AS copy\n    WHERE copy.route = parameters.route\n      AND copy.account_id = parameters.account_id\n      AND copy.deletion_id IS NULL\n      AND copy.status > previous.id\n    ORDER BY copy.status, copy.created_at, copy.copy_id\n    LIMIT 1\n  ) AS next\n  WHERE previous.ordinal < parameters.max_options\n)\nSELECT 'kind'::text AS dimension, id, \"copyId\", \"copyKind\", \"profilePin\"\nFROM kind_choices\nUNION ALL\nSELECT 'status'::text AS dimension, id, \"copyId\", \"copyKind\", \"profilePin\"\nFROM status_choices\nORDER BY dimension, id;\n";
export declare const params: readonly ["route", "account_id", "limit"];
/**
 * ```sql
 * WITH RECURSIVE
 * input AS (
 *   SELECT :route::integer AS route, :account_id::uuid AS account_id, :limit::integer AS max_options
 * ),
 * kind_seed AS (
 *   SELECT copy.kind AS id,
 *          copy.copy_id AS "copyId",
 *          copy.kind AS "copyKind",
 *          copy.kind_profile_pin AS "profilePin",
 *          1 AS ordinal
 *   FROM library.copy AS copy
 *   CROSS JOIN input AS parameters
 *   WHERE copy.route = parameters.route
 *     AND copy.account_id = parameters.account_id
 *     AND copy.deletion_id IS NULL
 *     AND copy.kind IS NOT NULL
 *   ORDER BY copy.kind, copy.created_at, copy.copy_id
 *   LIMIT 1
 * ),
 * kind_choices AS (
 *   SELECT * FROM kind_seed
 *   UNION ALL
 *   SELECT next.id, next."copyId", next."copyKind", next."profilePin", previous.ordinal + 1
 *   FROM kind_choices AS previous
 *   CROSS JOIN input AS parameters
 *   CROSS JOIN LATERAL (
 *     SELECT copy.kind AS id,
 *            copy.copy_id AS "copyId",
 *            copy.kind AS "copyKind",
 *            copy.kind_profile_pin AS "profilePin"
 *     FROM library.copy AS copy
 *     WHERE copy.route = parameters.route
 *       AND copy.account_id = parameters.account_id
 *       AND copy.deletion_id IS NULL
 *       AND copy.kind IS NOT NULL
 *       AND copy.kind > previous.id
 *     ORDER BY copy.kind, copy.created_at, copy.copy_id
 *     LIMIT 1
 *   ) AS next
 *   WHERE previous.ordinal < parameters.max_options
 * ),
 * status_seed AS (
 *   SELECT copy.status AS id,
 *          copy.copy_id AS "copyId",
 *          copy.kind AS "copyKind",
 *          COALESCE(copy.status_profile_pin, copy.library_profile_pin) AS "profilePin",
 *          1 AS ordinal
 *   FROM library.copy AS copy
 *   CROSS JOIN input AS parameters
 *   WHERE copy.route = parameters.route
 *     AND copy.account_id = parameters.account_id
 *     AND copy.deletion_id IS NULL
 *   ORDER BY copy.status, copy.created_at, copy.copy_id
 *   LIMIT 1
 * ),
 * status_choices AS (
 *   SELECT * FROM status_seed
 *   UNION ALL
 *   SELECT next.id, next."copyId", next."copyKind", next."profilePin", previous.ordinal + 1
 *   FROM status_choices AS previous
 *   CROSS JOIN input AS parameters
 *   CROSS JOIN LATERAL (
 *     SELECT copy.status AS id,
 *            copy.copy_id AS "copyId",
 *            copy.kind AS "copyKind",
 *            COALESCE(copy.status_profile_pin, copy.library_profile_pin) AS "profilePin"
 *     FROM library.copy AS copy
 *     WHERE copy.route = parameters.route
 *       AND copy.account_id = parameters.account_id
 *       AND copy.deletion_id IS NULL
 *       AND copy.status > previous.id
 *     ORDER BY copy.status, copy.created_at, copy.copy_id
 *     LIMIT 1
 *   ) AS next
 *   WHERE previous.ordinal < parameters.max_options
 * )
 * SELECT 'kind'::text AS dimension, id, "copyId", "copyKind", "profilePin"
 * FROM kind_choices
 * UNION ALL
 * SELECT 'status'::text AS dimension, id, "copyId", "copyKind", "profilePin"
 * FROM status_choices
 * ORDER BY dimension, id;
 * ```
 */
declare const query: Query<{
    route: number;
    account_id: string;
    limit: number;
}, {
    dimension: string;
    id: string;
    copyId: string | null;
    copyKind: string | null;
    profilePin: Json;
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
