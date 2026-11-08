import type { Json, Query } from "reylo";
export type Params = {
    status: string;
    location?: string | null;
    source?: string | null;
    acquired_on?: string | null;
    disposed_on?: string | null;
    note?: string | null;
    time: string;
    transaction_id: string;
    library_profile_pin?: Json;
    /** Private physical media observation with its exact accepting profile pin; SQL NULL means not recorded. */
    media_condition?: Json;
    /** Private physical packaging observation with its exact accepting profile pin; SQL NULL means not recorded. */
    packaging_condition?: Json;
    route: number;
    copy_id: string;
    revision: number;
};
export type Row = {
    route: number;
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
    /** Private physical media observation with its exact accepting profile pin; SQL NULL means not recorded. */
    mediaCondition: Json;
    /** Private physical packaging observation with its exact accepting profile pin; SQL NULL means not recorded. */
    packagingCondition: Json;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "UPDATE library.copy\nSET status = $1, location = $2::text, source = $3::text,\n    acquired_on = $4::date, disposed_on = $5::date,\n    note = $6::text, revision = revision + 1, updated_at = $7, transaction_id = $8,\n    status_profile_pin = COALESCE($9::jsonb, status_profile_pin),\n    media_condition = $10::jsonb,\n    packaging_condition = $11::jsonb\nWHERE deletion_id IS NULL AND route = $12 AND copy_id = $13 AND revision = $14\nRETURNING route, copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status, location, source,\n          acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n          created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n          media_condition AS \"mediaCondition\", packaging_condition AS \"packagingCondition\";";
export declare const raw: "UPDATE library.copy\nSET status = :status, location = :location::nullable(text), source = :source::nullable(text),\n    acquired_on = :acquired_on::nullable(date), disposed_on = :disposed_on::nullable(date),\n    note = :note::nullable(text), revision = revision + 1, updated_at = :time, transaction_id = :transaction_id,\n    status_profile_pin = COALESCE(:library_profile_pin::nullable(jsonb), status_profile_pin),\n    media_condition = :media_condition::nullable(jsonb),\n    packaging_condition = :packaging_condition::nullable(jsonb)\nWHERE deletion_id IS NULL AND route = :route AND copy_id = :copy_id AND revision = :revision\nRETURNING route, copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status, location, source,\n          acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n          created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n          media_condition AS \"mediaCondition\", packaging_condition AS \"packagingCondition\";\n";
export declare const params: readonly ["status", "location", "source", "acquired_on", "disposed_on", "note", "time", "transaction_id", "library_profile_pin", "media_condition", "packaging_condition", "route", "copy_id", "revision"];
/**
 * ```sql
 * UPDATE library.copy
 * SET status = :status, location = :location::nullable(text), source = :source::nullable(text),
 *     acquired_on = :acquired_on::nullable(date), disposed_on = :disposed_on::nullable(date),
 *     note = :note::nullable(text), revision = revision + 1, updated_at = :time, transaction_id = :transaction_id,
 *     status_profile_pin = COALESCE(:library_profile_pin::nullable(jsonb), status_profile_pin),
 *     media_condition = :media_condition::nullable(jsonb),
 *     packaging_condition = :packaging_condition::nullable(jsonb)
 * WHERE deletion_id IS NULL AND route = :route AND copy_id = :copy_id AND revision = :revision
 * RETURNING route, copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status, location, source,
 *           acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
 *           created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId",
 *           media_condition AS "mediaCondition", packaging_condition AS "packagingCondition";
 * ```
 */
declare const query: Query<{
    status: string;
    location?: string | null;
    source?: string | null;
    acquired_on?: string | null;
    disposed_on?: string | null;
    note?: string | null;
    time: string;
    transaction_id: string;
    library_profile_pin?: Json;
    /** Private physical media observation with its exact accepting profile pin; SQL NULL means not recorded. */
    media_condition?: Json;
    /** Private physical packaging observation with its exact accepting profile pin; SQL NULL means not recorded. */
    packaging_condition?: Json;
    route: number;
    copy_id: string;
    revision: number;
}, {
    route: number;
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
