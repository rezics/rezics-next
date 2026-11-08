import type { Query } from "reylo";
export type Params = {
    time: string;
    deletion_id: string;
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
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "WITH input AS (SELECT $1::timestamptz AS time)\nUPDATE library.copy\nSET deletion_id = $2::uuid, deleted_at = input.time,\n    restore_until = input.time + interval '720 hours', revision = revision + 1\nFROM input\nWHERE route = $3::integer AND copy_id = $4::uuid AND revision = $5::integer\n  AND deletion_id IS NULL AND revision <= 2147483644\nRETURNING route, copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status, location, source,\n          acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n          created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\";";
export declare const raw: "WITH input AS (SELECT :time::timestamptz AS time)\nUPDATE library.copy\nSET deletion_id = :deletion_id::uuid, deleted_at = input.time,\n    restore_until = input.time + interval '720 hours', revision = revision + 1\nFROM input\nWHERE route = :route::integer AND copy_id = :copy_id::uuid AND revision = :revision::integer\n  AND deletion_id IS NULL AND revision <= 2147483644\nRETURNING route, copy_id AS id, account_id AS \"accountId\", subject_id AS \"subjectId\", kind, status, location, source,\n          acquired_on::text AS \"acquiredOn\", disposed_on::text AS \"disposedOn\", note, revision,\n          created_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\", transaction_id AS \"transactionId\";\n";
export declare const params: readonly ["time", "deletion_id", "route", "copy_id", "revision"];
/**
 * ```sql
 * WITH input AS (SELECT :time::timestamptz AS time)
 * UPDATE library.copy
 * SET deletion_id = :deletion_id::uuid, deleted_at = input.time,
 *     restore_until = input.time + interval '720 hours', revision = revision + 1
 * FROM input
 * WHERE route = :route::integer AND copy_id = :copy_id::uuid AND revision = :revision::integer
 *   AND deletion_id IS NULL AND revision <= 2147483644
 * RETURNING route, copy_id AS id, account_id AS "accountId", subject_id AS "subjectId", kind, status, location, source,
 *           acquired_on::text AS "acquiredOn", disposed_on::text AS "disposedOn", note, revision,
 *           created_at::text AS "createdAt", updated_at::text AS "updatedAt", transaction_id AS "transactionId";
 * ```
 */
declare const query: Query<{
    time: string;
    deletion_id: string;
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
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
