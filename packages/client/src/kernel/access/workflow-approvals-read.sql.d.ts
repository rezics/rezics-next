import type { Query } from "reylo";
export type Params = {
    at: string;
    route: number;
    approval_id: string;
};
export type Row = {
    route: number;
    approvalId: string;
    actorId: string;
    clientId: string;
    scopes: (string | null)[];
    requestedBy: string | null;
    authnEpoch: string;
    operationKey: string;
    operation: unknown;
    digest: string;
    createdAt: string;
    expiresAt: string;
    jwtExpiresAt: string;
    transactionId: string;
};
/**
 * ```sql
 * WITH input AS (SELECT $1::timestamptz AS at)
 * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
 *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
 *        operation_key AS "operationKey", operation, digest,
 *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
 *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
 * FROM access.workflow_approval CROSS JOIN input i
 * WHERE route = $2 AND approval_id = $3
 *   AND expires_at > i.at AND jwt_expires_at > i.at;
 * ```
 *
 * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
 */
export declare const sql: "WITH input AS (SELECT $1::timestamptz AS at)\nSELECT route, approval_id AS \"approvalId\", actor_id AS \"actorId\", client_id AS \"clientId\",\n       scopes, requested_by AS \"requestedBy\", authn_epoch::text AS \"authnEpoch\",\n       operation_key AS \"operationKey\", operation, digest,\n       created_at::text AS \"createdAt\", expires_at::text AS \"expiresAt\",\n       jwt_expires_at::text AS \"jwtExpiresAt\", transaction_id AS \"transactionId\"\nFROM access.workflow_approval CROSS JOIN input i\nWHERE route = $2 AND approval_id = $3\n  AND expires_at > i.at AND jwt_expires_at > i.at /*file='src%2Faccess%2Fworkflow-approvals-read.sql'*/;";
/**
 * ```sql
 * WITH input AS (SELECT :at::timestamptz AS at)
 * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
 *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
 *        operation_key AS "operationKey", operation, digest,
 *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
 *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
 * FROM access.workflow_approval CROSS JOIN input i
 * WHERE route = :route AND approval_id = :approval_id
 *   AND expires_at > i.at AND jwt_expires_at > i.at;
 * ```
 *
 * The `.sql` file's contents, exactly as written, as the module's `raw` export.
 */
export declare const raw: "WITH input AS (SELECT :at::timestamptz AS at)\nSELECT route, approval_id AS \"approvalId\", actor_id AS \"actorId\", client_id AS \"clientId\",\n       scopes, requested_by AS \"requestedBy\", authn_epoch::text AS \"authnEpoch\",\n       operation_key AS \"operationKey\", operation, digest,\n       created_at::text AS \"createdAt\", expires_at::text AS \"expiresAt\",\n       jwt_expires_at::text AS \"jwtExpiresAt\", transaction_id AS \"transactionId\"\nFROM access.workflow_approval CROSS JOIN input i\nWHERE route = :route AND approval_id = :approval_id\n  AND expires_at > i.at AND jwt_expires_at > i.at;\n";
export declare const params: readonly ["at", "route", "approval_id"];
/**
 * ```sql
 * WITH input AS (SELECT :at::timestamptz AS at)
 * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
 *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
 *        operation_key AS "operationKey", operation, digest,
 *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
 *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
 * FROM access.workflow_approval CROSS JOIN input i
 * WHERE route = :route AND approval_id = :approval_id
 *   AND expires_at > i.at AND jwt_expires_at > i.at;
 * ```
 */
declare const query: Query<{
    at: string;
    route: number;
    approval_id: string;
}, {
    route: number;
    approvalId: string;
    actorId: string;
    clientId: string;
    scopes: (string | null)[];
    requestedBy: string | null;
    authnEpoch: string;
    operationKey: string;
    operation: unknown;
    digest: string;
    createdAt: string;
    expiresAt: string;
    jwtExpiresAt: string;
    transactionId: string;
}, "maybeOne", "postgres"> & {
    /**
     * ```sql
     * WITH input AS (SELECT $1::timestamptz AS at)
     * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
     *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
     *        operation_key AS "operationKey", operation, digest,
     *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
     *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
     * FROM access.workflow_approval CROSS JOIN input i
     * WHERE route = $2 AND approval_id = $3
     *   AND expires_at > i.at AND jwt_expires_at > i.at;
     * ```
     *
     * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
     */
    readonly sql: typeof sql;
    /**
     * ```sql
     * WITH input AS (SELECT :at::timestamptz AS at)
     * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
     *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
     *        operation_key AS "operationKey", operation, digest,
     *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
     *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
     * FROM access.workflow_approval CROSS JOIN input i
     * WHERE route = :route AND approval_id = :approval_id
     *   AND expires_at > i.at AND jwt_expires_at > i.at;
     * ```
     *
     * The `.sql` file's contents, exactly as written, as the module's `raw` export.
     */
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
