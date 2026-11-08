import type { Json, Query } from "reylo";
export type Params = {
    time: string;
    route: number;
    copy_id: string;
    account_id: string;
};
export type Row = {
    id: string;
    accountId: string;
    subjectId: string;
    kind: string | null;
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
    libraryProfilePin: Json;
    deletionId: string | null;
    deletedAt: string | null;
    restoreUntil: string | null;
    expired: boolean | null;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status,\n       location, source, acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n       created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n       library_profile_pin AS \"libraryProfilePin\", deletion_id AS \"deletionId\",\n       deleted_at::text AS \"deletedAt\", restore_until::text AS \"restoreUntil\",\n       restore_until <= $1::timestamptz AS expired\nFROM library.copy\nWHERE route = $2::integer AND copy_id = $3::uuid AND account_id = $4::uuid\nFOR UPDATE;";
export declare const raw: "SELECT copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status,\n       location, source, acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n       created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n       library_profile_pin AS \"libraryProfilePin\", deletion_id AS \"deletionId\",\n       deleted_at::text AS \"deletedAt\", restore_until::text AS \"restoreUntil\",\n       restore_until <= :time::timestamptz AS expired\nFROM library.copy\nWHERE route = :route::integer AND copy_id = :copy_id::uuid AND account_id = :account_id::uuid\nFOR UPDATE;\n";
export declare const params: readonly ["time", "route", "copy_id", "account_id"];
/**
 * ```sql
 * SELECT copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status,
 *        location, source, acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
 *        created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId",
 *        library_profile_pin AS "libraryProfilePin", deletion_id AS "deletionId",
 *        deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil",
 *        restore_until <= :time::timestamptz AS expired
 * FROM library.copy
 * WHERE route = :route::integer AND copy_id = :copy_id::uuid AND account_id = :account_id::uuid
 * FOR UPDATE;
 * ```
 */
declare const query: Query<{
    time: string;
    route: number;
    copy_id: string;
    account_id: string;
}, {
    id: string;
    accountId: string;
    subjectId: string;
    kind: string | null;
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
    libraryProfilePin: Json;
    deletionId: string | null;
    deletedAt: string | null;
    restoreUntil: string | null;
    expired: boolean | null;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
