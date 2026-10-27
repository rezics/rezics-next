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
/**
 * ```sql
 * SELECT m.role
 * FROM access.organization_member m
 * JOIN access.account a ON a.route = m.route AND a.account_id = m.organization_id
 * WHERE m.route = $1 AND m.organization_id = $2
 *   AND a.kind = 'organization' AND a.state = 'active' AND NOT a.authn_fenced
 *   AND m.member_account_id = $3 AND m.valid @> $4::timestamptz
 * LIMIT 1;
 * ```
 *
 * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
 */
export declare const sql: "SELECT m.role\nFROM access.organization_member m\nJOIN access.account a ON a.route = m.route AND a.account_id = m.organization_id\nWHERE m.route = $1 AND m.organization_id = $2\n  AND a.kind = 'organization' AND a.state = 'active' AND NOT a.authn_fenced\n  AND m.member_account_id = $3 AND m.valid @> $4::timestamptz\nLIMIT 1 /*file='src%2Faccess%2Faccount-organization-role.sql'*/;";
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
 *
 * The `.sql` file's contents, exactly as written, as the module's `raw` export.
 */
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
}, "maybeOne", "postgres"> & {
    /**
     * ```sql
     * SELECT m.role
     * FROM access.organization_member m
     * JOIN access.account a ON a.route = m.route AND a.account_id = m.organization_id
     * WHERE m.route = $1 AND m.organization_id = $2
     *   AND a.kind = 'organization' AND a.state = 'active' AND NOT a.authn_fenced
     *   AND m.member_account_id = $3 AND m.valid @> $4::timestamptz
     * LIMIT 1;
     * ```
     *
     * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
     */
    readonly sql: typeof sql;
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
     *
     * The `.sql` file's contents, exactly as written, as the module's `raw` export.
     */
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
