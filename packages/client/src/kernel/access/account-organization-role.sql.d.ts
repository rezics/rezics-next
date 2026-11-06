import type { Query } from "reylo";
export type Params = {
    route: number;
    organization_id: string;
    member_account_id: string;
    at: string;
};
export type Row = {
    role: "owner" | "member";
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT m.role\nFROM access.organization_member m\nJOIN access.account a ON a.route = m.route AND a.account_id = m.organization_id\nWHERE m.route = $1 AND m.organization_id = $2\n  AND a.kind = 'organization' AND a.state = 'active' AND NOT a.authn_fenced\n  AND m.member_account_id = $3 AND m.valid @> $4::timestamptz\nLIMIT 1;";
export declare const raw: "SELECT m.role\nFROM access.organization_member m\nJOIN access.account a ON a.route = m.route AND a.account_id = m.organization_id\nWHERE m.route = :route AND m.organization_id = :organization_id\n  AND a.kind = 'organization' AND a.state = 'active' AND NOT a.authn_fenced\n  AND m.member_account_id = :member_account_id AND m.valid @> :at::timestamptz\nLIMIT 1;\n";
export declare const params: readonly ["route", "organization_id", "member_account_id", "at"];
/**
 * ```sql
 * SELECT m.role
 * FROM access.organization_member m
 * JOIN access.account a ON a.route = m.route AND a.account_id = m.organization_id
 * WHERE m.route = :route AND m.organization_id = :organization_id
 *   AND a.kind = 'organization' AND a.state = 'active' AND NOT a.authn_fenced
 *   AND m.member_account_id = :member_account_id AND m.valid @> :at::timestamptz
 * LIMIT 1;
 * ```
 */
declare const query: Query<{
    route: number;
    organization_id: string;
    member_account_id: string;
    at: string;
}, {
    role: "owner" | "member";
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
