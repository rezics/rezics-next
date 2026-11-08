import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    account_id: string;
    after_created_at?: string | null;
    after_copy_id?: string | null;
    limit: number;
};
export type Row = {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
    kind: string | null;
    libraryProfilePin: Json;
    status: string;
    location: string | null;
    source: string | null;
    acquiredOn: string | null;
    disposedOn: string | null;
    note: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
    transactionId: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT copy.route,\n       copy.copy_id AS id,\n       copy.account_id AS \"accountId\",\n       copy.subject_id AS \"subjectId\",\n       copy.kind,\n       copy.library_profile_pin AS \"libraryProfilePin\",\n       copy.status,\n       copy.location,\n       copy.source,\n       copy.acquired_on::text AS \"acquiredOn\",\n       copy.disposed_on::text AS \"disposedOn\",\n       copy.note,\n       copy.revision,\n       copy.created_at::text AS \"createdAt\",\n       copy.updated_at::text AS \"updatedAt\",\n       copy.transaction_id AS \"transactionId\"\nFROM library.copy AS copy\nWHERE copy.route = $1::integer\n  AND copy.deletion_id IS NULL\n  AND copy.account_id = $2::uuid\n  AND (copy.created_at, copy.copy_id) > (\n    COALESCE($3::timestamptz, '-infinity'::timestamptz),\n    COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)\n  )\nORDER BY copy.created_at, copy.copy_id\nLIMIT $5::integer;";
export declare const raw: "SELECT copy.route,\n       copy.copy_id AS id,\n       copy.account_id AS \"accountId\",\n       copy.subject_id AS \"subjectId\",\n       copy.kind,\n       copy.library_profile_pin AS \"libraryProfilePin\",\n       copy.status,\n       copy.location,\n       copy.source,\n       copy.acquired_on::text AS \"acquiredOn\",\n       copy.disposed_on::text AS \"disposedOn\",\n       copy.note,\n       copy.revision,\n       copy.created_at::text AS \"createdAt\",\n       copy.updated_at::text AS \"updatedAt\",\n       copy.transaction_id AS \"transactionId\"\nFROM library.copy AS copy\nWHERE copy.route = :route::integer\n  AND copy.deletion_id IS NULL\n  AND copy.account_id = :account_id::uuid\n  AND (copy.created_at, copy.copy_id) > (\n    COALESCE(:after_created_at::nullable(timestamptz), '-infinity'::timestamptz),\n    COALESCE(:after_copy_id::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid)\n  )\nORDER BY copy.created_at, copy.copy_id\nLIMIT :limit::integer;\n";
export declare const params: readonly ["route", "account_id", "after_created_at", "after_copy_id", "limit"];
/**
 * ```sql
 * SELECT copy.route,
 *        copy.copy_id AS id,
 *        copy.account_id AS "accountId",
 *        copy.subject_id AS "subjectId",
 *        copy.kind,
 *        copy.library_profile_pin AS "libraryProfilePin",
 *        copy.status,
 *        copy.location,
 *        copy.source,
 *        copy.acquired_on::text AS "acquiredOn",
 *        copy.disposed_on::text AS "disposedOn",
 *        copy.note,
 *        copy.revision,
 *        copy.created_at::text AS "createdAt",
 *        copy.updated_at::text AS "updatedAt",
 *        copy.transaction_id AS "transactionId"
 * FROM library.copy AS copy
 * WHERE copy.route = :route::integer
 *   AND copy.deletion_id IS NULL
 *   AND copy.account_id = :account_id::uuid
 *   AND (copy.created_at, copy.copy_id) > (
 *     COALESCE(:after_created_at::nullable(timestamptz), '-infinity'::timestamptz),
 *     COALESCE(:after_copy_id::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid)
 *   )
 * ORDER BY copy.created_at, copy.copy_id
 * LIMIT :limit::integer;
 * ```
 */
declare const query: Query<{
    route: number;
    account_id: string;
    after_created_at?: string | null;
    after_copy_id?: string | null;
    limit: number;
}, {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
    kind: string | null;
    libraryProfilePin: Json;
    status: string;
    location: string | null;
    source: string | null;
    acquiredOn: string | null;
    disposedOn: string | null;
    note: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
    transactionId: string;
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
