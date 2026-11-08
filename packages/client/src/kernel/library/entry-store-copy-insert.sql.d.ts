import type { Json, Query } from "reylo";
export type Params = {
    time: string;
    library_profile_pin?: Json;
    route: number;
    copy_id: string;
    account_id: string;
    subject_id: string;
    status: string;
    location?: string | null;
    source?: string | null;
    acquired_on?: string | null;
    disposed_on?: string | null;
    note?: string | null;
    transaction_id: string;
    kind?: string | null;
    media_condition?: Json;
    packaging_condition?: Json;
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
export declare const sql: "WITH input AS (\n  SELECT $1::timestamptz AS time, $2::jsonb AS pin\n)\nINSERT INTO library.copy\n  (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,\n   created_at, updated_at, transaction_id, kind, library_profile_pin, kind_profile_pin, status_profile_pin,\n   media_condition, packaging_condition)\nSELECT $3, $4, $5, $6, $7, $8::text, $9::text,\n       $10::date, $11::date, $12::text, 1, input.time, input.time,\n       $13, $14::text, input.pin, input.pin, input.pin,\n       $15::jsonb, $16::jsonb\nFROM input\nRETURNING route, copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status, location, source,\n          acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n          created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n          media_condition AS \"mediaCondition\", packaging_condition AS \"packagingCondition\";";
export declare const raw: "WITH input AS (\n  SELECT :time::timestamptz AS time, :library_profile_pin::nullable(jsonb) AS pin\n)\nINSERT INTO library.copy\n  (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,\n   created_at, updated_at, transaction_id, kind, library_profile_pin, kind_profile_pin, status_profile_pin,\n   media_condition, packaging_condition)\nSELECT :route, :copy_id, :account_id, :subject_id, :status, :location::nullable(text), :source::nullable(text),\n       :acquired_on::nullable(date), :disposed_on::nullable(date), :note::nullable(text), 1, input.time, input.time,\n       :transaction_id, :kind::nullable(text), input.pin, input.pin, input.pin,\n       :media_condition::nullable(jsonb), :packaging_condition::nullable(jsonb)\nFROM input\nRETURNING route, copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status, location, source,\n          acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n          created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\",\n          media_condition AS \"mediaCondition\", packaging_condition AS \"packagingCondition\";\n";
export declare const params: readonly ["time", "library_profile_pin", "route", "copy_id", "account_id", "subject_id", "status", "location", "source", "acquired_on", "disposed_on", "note", "transaction_id", "kind", "media_condition", "packaging_condition"];
/**
 * ```sql
 * WITH input AS (
 *   SELECT :time::timestamptz AS time, :library_profile_pin::nullable(jsonb) AS pin
 * )
 * INSERT INTO library.copy
 *   (route, copy_id, account_id, subject_id, status, location, source, acquired_on, disposed_on, note, revision,
 *    created_at, updated_at, transaction_id, kind, library_profile_pin, kind_profile_pin, status_profile_pin,
 *    media_condition, packaging_condition)
 * SELECT :route, :copy_id, :account_id, :subject_id, :status, :location::nullable(text), :source::nullable(text),
 *        :acquired_on::nullable(date), :disposed_on::nullable(date), :note::nullable(text), 1, input.time, input.time,
 *        :transaction_id, :kind::nullable(text), input.pin, input.pin, input.pin,
 *        :media_condition::nullable(jsonb), :packaging_condition::nullable(jsonb)
 * FROM input
 * RETURNING route, copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status, location, source,
 *           acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
 *           created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId",
 *           media_condition AS "mediaCondition", packaging_condition AS "packagingCondition";
 * ```
 */
declare const query: Query<{
    time: string;
    library_profile_pin?: Json;
    route: number;
    copy_id: string;
    account_id: string;
    subject_id: string;
    status: string;
    location?: string | null;
    source?: string | null;
    acquired_on?: string | null;
    disposed_on?: string | null;
    note?: string | null;
    transaction_id: string;
    kind?: string | null;
    media_condition?: Json;
    packaging_condition?: Json;
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
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
