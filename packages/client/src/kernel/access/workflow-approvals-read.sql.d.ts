import type { Query } from "reylo";
export type Params = {
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
 * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
 *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
 *        operation_key AS "operationKey", operation, digest,
 *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
 *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
 * FROM access.workflow_approval
 * WHERE route = $1 AND approval_id = $2
 *   AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
 * ```
 *
 * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
 */
export declare const sql: "SELECT route, approval_id AS \"approvalId\", actor_id AS \"actorId\", client_id AS \"clientId\",\n       scopes, requested_by AS \"requestedBy\", authn_epoch::text AS \"authnEpoch\",\n       operation_key AS \"operationKey\", operation, digest,\n       created_at::text AS \"createdAt\", expires_at::text AS \"expiresAt\",\n       jwt_expires_at::text AS \"jwtExpiresAt\", transaction_id AS \"transactionId\"\nFROM access.workflow_approval\nWHERE route = $1 AND approval_id = $2\n  AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp() /*file='src%2Faccess%2Fworkflow-approvals-read.sql'*/;";
/**
 * ```sql
 * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
 *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
 *        operation_key AS "operationKey", operation, digest,
 *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
 *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
 * FROM access.workflow_approval
 * WHERE route = :route AND approval_id = :approval_id
 *   AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
 * ```
 *
 * The `.sql` file's contents, exactly as written, as the module's `raw` export.
 */
export declare const raw: "SELECT route, approval_id AS \"approvalId\", actor_id AS \"actorId\", client_id AS \"clientId\",\n       scopes, requested_by AS \"requestedBy\", authn_epoch::text AS \"authnEpoch\",\n       operation_key AS \"operationKey\", operation, digest,\n       created_at::text AS \"createdAt\", expires_at::text AS \"expiresAt\",\n       jwt_expires_at::text AS \"jwtExpiresAt\", transaction_id AS \"transactionId\"\nFROM access.workflow_approval\nWHERE route = :route AND approval_id = :approval_id\n  AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();\n";
export declare const params: readonly ["route", "approval_id"];
/**
 * ```sql
 * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
 *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
 *        operation_key AS "operationKey", operation, digest,
 *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
 *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
 * FROM access.workflow_approval
 * WHERE route = :route AND approval_id = :approval_id
 *   AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
 * ```
 */
declare const query: Query<{
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
     * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
     *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
     *        operation_key AS "operationKey", operation, digest,
     *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
     *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
     * FROM access.workflow_approval
     * WHERE route = $1 AND approval_id = $2
     *   AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
     * ```
     *
     * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
     */
    readonly sql: typeof sql;
    /**
     * ```sql
     * SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
     *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
     *        operation_key AS "operationKey", operation, digest,
     *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
     *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
     * FROM access.workflow_approval
     * WHERE route = :route AND approval_id = :approval_id
     *   AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
     * ```
     *
     * The `.sql` file's contents, exactly as written, as the module's `raw` export.
     */
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
