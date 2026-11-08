import type { Json, Query } from "reylo";
export type Params = {
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
    kindProfilePin: Json;
    statusProfilePin: Json;
    /** Private physical media observation with its exact accepting profile pin; SQL NULL means not recorded. */
    mediaCondition: Json;
    /** Private physical packaging observation with its exact accepting profile pin; SQL NULL means not recorded. */
    packagingCondition: Json;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status, location, source,\n       acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n       created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n       library_profile_pin AS \"libraryProfilePin\", kind_profile_pin AS \"kindProfilePin\",\n       status_profile_pin AS \"statusProfilePin\", media_condition AS \"mediaCondition\",\n       packaging_condition AS \"packagingCondition\"\nFROM library.copy\nWHERE deletion_id IS NULL AND route = $1 AND copy_id = $2 AND account_id = $3;";
export declare const raw: "SELECT copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status, location, source,\n       acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n       created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n       library_profile_pin AS \"libraryProfilePin\", kind_profile_pin AS \"kindProfilePin\",\n       status_profile_pin AS \"statusProfilePin\", media_condition AS \"mediaCondition\",\n       packaging_condition AS \"packagingCondition\"\nFROM library.copy\nWHERE deletion_id IS NULL AND route = :route AND copy_id = :copy_id AND account_id = :account_id;\n";
export declare const params: readonly ["route", "copy_id", "account_id"];
/**
 * ```sql
 * SELECT copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status, location, source,
 *        acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
 *        created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId",
 *        library_profile_pin AS "libraryProfilePin", kind_profile_pin AS "kindProfilePin",
 *        status_profile_pin AS "statusProfilePin", media_condition AS "mediaCondition",
 *        packaging_condition AS "packagingCondition"
 * FROM library.copy
 * WHERE deletion_id IS NULL AND route = :route AND copy_id = :copy_id AND account_id = :account_id;
 * ```
 */
declare const query: Query<{
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
    kindProfilePin: Json;
    statusProfilePin: Json;
    /** Private physical media observation with its exact accepting profile pin; SQL NULL means not recorded. */
    mediaCondition: Json;
    /** Private physical packaging observation with its exact accepting profile pin; SQL NULL means not recorded. */
    packagingCondition: Json;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
