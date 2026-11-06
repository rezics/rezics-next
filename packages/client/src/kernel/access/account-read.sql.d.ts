import type { Json, Query } from "reylo";
export type Params = {
    route: number;
    account_id: string;
};
export type Row = {
    route: number;
    accountId: string;
    kind: "actor" | "organization";
    handle: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    biography: string | null;
    state: "pending" | "active" | "suspended" | "deleted";
    operatorAccountId: string | null;
    controllerId: string | null;
    birthDate: string | null;
    contentPreferences: Json;
    suspensionReason: string | null;
    minimumAuthnEpoch: string;
    fenced: boolean;
    createdAt: number | null;
    rateTier: "ordinary" | "trusted" | "service";
    transactionId: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT route, account_id AS \"accountId\", kind, handle, display_name AS \"displayName\",\n       avatar_url AS \"avatarUrl\", biography, state, operator_account_id AS \"operatorAccountId\",\n       controller_id AS \"controllerId\", to_char(birth_date, 'YYYY-MM-DD') AS \"birthDate\",\n       content_preferences AS \"contentPreferences\", suspension_reason AS \"suspensionReason\",\n       minimum_authn_epoch::text AS \"minimumAuthnEpoch\", authn_fenced AS fenced,\n       (extract(epoch FROM created_at) * 1000)::double precision AS \"createdAt\",\n       rate_tier AS \"rateTier\", transaction_id AS \"transactionId\"\nFROM access.account\nWHERE route = $1 AND account_id = $2;";
export declare const raw: "SELECT route, account_id AS \"accountId\", kind, handle, display_name AS \"displayName\",\n       avatar_url AS \"avatarUrl\", biography, state, operator_account_id AS \"operatorAccountId\",\n       controller_id AS \"controllerId\", to_char(birth_date, 'YYYY-MM-DD') AS \"birthDate\",\n       content_preferences AS \"contentPreferences\", suspension_reason AS \"suspensionReason\",\n       minimum_authn_epoch::text AS \"minimumAuthnEpoch\", authn_fenced AS fenced,\n       (extract(epoch FROM created_at) * 1000)::double precision AS \"createdAt\",\n       rate_tier AS \"rateTier\", transaction_id AS \"transactionId\"\nFROM access.account\nWHERE route = :route AND account_id = :account_id;\n";
export declare const params: readonly ["route", "account_id"];
/**
 * ```sql
 * SELECT route, account_id AS "accountId", kind, handle, display_name AS "displayName",
 *        avatar_url AS "avatarUrl", biography, state, operator_account_id AS "operatorAccountId",
 *        controller_id AS "controllerId", to_char(birth_date, 'YYYY-MM-DD') AS "birthDate",
 *        content_preferences AS "contentPreferences", suspension_reason AS "suspensionReason",
 *        minimum_authn_epoch::text AS "minimumAuthnEpoch", authn_fenced AS fenced,
 *        (extract(epoch FROM created_at) * 1000)::double precision AS "createdAt",
 *        rate_tier AS "rateTier", transaction_id AS "transactionId"
 * FROM access.account
 * WHERE route = :route AND account_id = :account_id;
 * ```
 */
declare const query: Query<{
    route: number;
    account_id: string;
}, {
    route: number;
    accountId: string;
    kind: "actor" | "organization";
    handle: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    biography: string | null;
    state: "pending" | "active" | "suspended" | "deleted";
    operatorAccountId: string | null;
    controllerId: string | null;
    birthDate: string | null;
    contentPreferences: Json;
    suspensionReason: string | null;
    minimumAuthnEpoch: string;
    fenced: boolean;
    createdAt: number | null;
    rateTier: "ordinary" | "trusted" | "service";
    transactionId: string;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
