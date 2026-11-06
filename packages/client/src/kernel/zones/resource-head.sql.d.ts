import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    id: string;
};
export type Row = {
    route: number;
    id: string;
    revision: string;
    state: "active" | "deleted" | "purge_pending" | "purged";
    ownerId: string | null;
    visibility: "private" | "unlisted" | "public";
    configuration: Json;
    mounts: (string | null)[] | null;
    releaseDigest: string;
    publicEver: boolean;
    writeFenced: boolean;
    lifecycleRevision: string;
    withholding: Json;
    held: boolean;
    deletedAt: string | null;
    restoreUntil: string | null;
    deletionGeneration: string | null;
    createdAt: string;
    updatedAt: string;
    creationTransactionId: string;
    transactionId: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT route, zone_id AS id, revision::text AS revision, state, owner_id AS \"ownerId\", visibility,\nconfiguration, mounts, release_digest AS \"releaseDigest\", public_ever AS \"publicEver\",\nwrite_fenced AS \"writeFenced\", lifecycle_revision::text AS \"lifecycleRevision\", withholding, held,\ndeleted_at::text AS \"deletedAt\", restore_until::text AS \"restoreUntil\",\ndeletion_generation::text AS \"deletionGeneration\",\ncreated_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\",\ncreation_transaction_id AS \"creationTransactionId\", transaction_id AS \"transactionId\" FROM zones.zone\nWHERE route = $1::integer AND zone_id = $2::uuid;";
export declare const raw: "SELECT route, zone_id AS id, revision::text AS revision, state, owner_id AS \"ownerId\", visibility,\nconfiguration, mounts, release_digest AS \"releaseDigest\", public_ever AS \"publicEver\",\nwrite_fenced AS \"writeFenced\", lifecycle_revision::text AS \"lifecycleRevision\", withholding, held,\ndeleted_at::text AS \"deletedAt\", restore_until::text AS \"restoreUntil\",\ndeletion_generation::text AS \"deletionGeneration\",\ncreated_at::text AS \"createdAt\", updated_at::text AS \"updatedAt\",\ncreation_transaction_id AS \"creationTransactionId\", transaction_id AS \"transactionId\" FROM zones.zone\nWHERE route = :route::integer AND zone_id = :id::uuid;\n";
export declare const params: readonly ["route", "id"];
/**
 * ```sql
 * SELECT route, zone_id AS id, revision::text AS revision, state, owner_id AS "ownerId", visibility,
 * configuration, mounts, release_digest AS "releaseDigest", public_ever AS "publicEver",
 * write_fenced AS "writeFenced", lifecycle_revision::text AS "lifecycleRevision", withholding, held,
 * deleted_at::text AS "deletedAt", restore_until::text AS "restoreUntil",
 * deletion_generation::text AS "deletionGeneration",
 * created_at::text AS "createdAt", updated_at::text AS "updatedAt",
 * creation_transaction_id AS "creationTransactionId", transaction_id AS "transactionId" FROM zones.zone
 * WHERE route = :route::integer AND zone_id = :id::uuid;
 * ```
 */
declare const query: Query<{
    route: number;
    id: string;
}, {
    route: number;
    id: string;
    revision: string;
    state: "active" | "deleted" | "purge_pending" | "purged";
    ownerId: string | null;
    visibility: "private" | "unlisted" | "public";
    configuration: Json;
    mounts: (string | null)[] | null;
    releaseDigest: string;
    publicEver: boolean;
    writeFenced: boolean;
    lifecycleRevision: string;
    withholding: Json;
    held: boolean;
    deletedAt: string | null;
    restoreUntil: string | null;
    deletionGeneration: string | null;
    createdAt: string;
    updatedAt: string;
    creationTransactionId: string;
    transactionId: string;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
