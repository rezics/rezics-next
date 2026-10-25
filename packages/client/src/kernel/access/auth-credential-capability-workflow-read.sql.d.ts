import type { Query } from "reylo";
export type Params = {
    route: number;
    receipt_id: string;
};
export type Row = {
    data: {
        route: number;
        approval_id: string;
        actor_id: string;
        client_id: string;
        scopes: (string | null)[];
        requested_by: string | null;
        authn_epoch: number;
        operation_key: string;
        operation: unknown;
        digest: string;
        created_at: string;
        expires_at: string;
        jwt_expires_at: string;
        transaction_id: string;
        consumed_at: string | null;
        consumed_transaction_id: string | null;
    };
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
 * SELECT to_jsonb(r) AS data,
 *        route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
 *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
 *        operation_key AS "operationKey", operation, digest,
 *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
 *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
 * FROM access.workflow_approval r
 * WHERE route = $1 AND approval_id = $2 AND consumed_at IS NOT NULL
 *   AND operation->>'kind' = 'credential' AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
 * ```
 *
 * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
 */
export declare const sql: "SELECT to_jsonb(r) AS data,\n       route, approval_id AS \"approvalId\", actor_id AS \"actorId\", client_id AS \"clientId\",\n       scopes, requested_by AS \"requestedBy\", authn_epoch::text AS \"authnEpoch\",\n       operation_key AS \"operationKey\", operation, digest,\n       created_at::text AS \"createdAt\", expires_at::text AS \"expiresAt\",\n       jwt_expires_at::text AS \"jwtExpiresAt\", transaction_id AS \"transactionId\"\nFROM access.workflow_approval r\nWHERE route = $1 AND approval_id = $2 AND consumed_at IS NOT NULL\n  AND operation->>'kind' = 'credential' AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp() /*file='src%2Faccess%2Fauth-credential-capability-workflow-read.sql'*/;";
/**
 * ```sql
 * SELECT to_jsonb(r) AS data,
 *        route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
 *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
 *        operation_key AS "operationKey", operation, digest,
 *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
 *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
 * FROM access.workflow_approval r
 * WHERE route = :route AND approval_id = :receipt_id AND consumed_at IS NOT NULL
 *   AND operation->>'kind' = 'credential' AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
 * ```
 *
 * The `.sql` file's contents, exactly as written, as the module's `raw` export.
 */
export declare const raw: "SELECT to_jsonb(r) AS data,\n       route, approval_id AS \"approvalId\", actor_id AS \"actorId\", client_id AS \"clientId\",\n       scopes, requested_by AS \"requestedBy\", authn_epoch::text AS \"authnEpoch\",\n       operation_key AS \"operationKey\", operation, digest,\n       created_at::text AS \"createdAt\", expires_at::text AS \"expiresAt\",\n       jwt_expires_at::text AS \"jwtExpiresAt\", transaction_id AS \"transactionId\"\nFROM access.workflow_approval r\nWHERE route = :route AND approval_id = :receipt_id AND consumed_at IS NOT NULL\n  AND operation->>'kind' = 'credential' AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();\n";
export declare const params: readonly ["route", "receipt_id"];
/**
 * ```sql
 * SELECT to_jsonb(r) AS data,
 *        route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
 *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
 *        operation_key AS "operationKey", operation, digest,
 *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
 *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
 * FROM access.workflow_approval r
 * WHERE route = :route AND approval_id = :receipt_id AND consumed_at IS NOT NULL
 *   AND operation->>'kind' = 'credential' AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
 * ```
 */
declare const query: Query<{
    route: number;
    receipt_id: string;
}, {
    data: {
        route: number;
        approval_id: string;
        actor_id: string;
        client_id: string;
        scopes: (string | null)[];
        requested_by: string | null;
        authn_epoch: number;
        operation_key: string;
        operation: unknown;
        digest: string;
        created_at: string;
        expires_at: string;
        jwt_expires_at: string;
        transaction_id: string;
        consumed_at: string | null;
        consumed_transaction_id: string | null;
    };
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
     * SELECT to_jsonb(r) AS data,
     *        route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
     *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
     *        operation_key AS "operationKey", operation, digest,
     *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
     *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
     * FROM access.workflow_approval r
     * WHERE route = $1 AND approval_id = $2 AND consumed_at IS NOT NULL
     *   AND operation->>'kind' = 'credential' AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
     * ```
     *
     * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
     */
    readonly sql: typeof sql;
    /**
     * ```sql
     * SELECT to_jsonb(r) AS data,
     *        route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
     *        scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
     *        operation_key AS "operationKey", operation, digest,
     *        created_at::text AS "createdAt", expires_at::text AS "expiresAt",
     *        jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
     * FROM access.workflow_approval r
     * WHERE route = :route AND approval_id = :receipt_id AND consumed_at IS NOT NULL
     *   AND operation->>'kind' = 'credential' AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
     * ```
     *
     * The `.sql` file's contents, exactly as written, as the module's `raw` export.
     */
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
