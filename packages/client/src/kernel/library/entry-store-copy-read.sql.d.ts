import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    copy_id: string;
};
export type Row = {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
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
    kind: string | null;
    libraryProfilePin: Json;
    /** Private physical media observation with its exact accepting profile pin; SQL NULL means not recorded. */
    mediaCondition: Json;
    /** Private physical packaging observation with its exact accepting profile pin; SQL NULL means not recorded. */
    packagingCondition: Json;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT route, copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", status, location, source,\n       acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n       created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n       kind, COALESCE(status_profile_pin, library_profile_pin) AS \"libraryProfilePin\",\n       media_condition AS \"mediaCondition\", packaging_condition AS \"packagingCondition\"\nFROM library.copy\nWHERE deletion_id IS NULL AND route = $1 AND copy_id = $2;";
export declare const raw: "SELECT route, copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", status, location, source,\n       acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n       created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n       kind, COALESCE(status_profile_pin, library_profile_pin) AS \"libraryProfilePin\",\n       media_condition AS \"mediaCondition\", packaging_condition AS \"packagingCondition\"\nFROM library.copy\nWHERE deletion_id IS NULL AND route = :route AND copy_id = :copy_id;\n";
export declare const params: readonly ["route", "copy_id"];
/**
 * ```sql
 * SELECT route, copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", status, location, source,
 *        acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
 *        created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId",
 *        kind, COALESCE(status_profile_pin, library_profile_pin) AS "libraryProfilePin",
 *        media_condition AS "mediaCondition", packaging_condition AS "packagingCondition"
 * FROM library.copy
 * WHERE deletion_id IS NULL AND route = :route AND copy_id = :copy_id;
 * ```
 */
declare const query: Query<{
    route: number;
    copy_id: string;
}, {
    route: number;
    id: string;
    accountId: string;
    subjectId: string;
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
    kind: string | null;
    libraryProfilePin: Json;
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
