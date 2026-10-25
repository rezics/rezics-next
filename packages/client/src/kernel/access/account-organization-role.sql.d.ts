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
 * SELECT role
 * FROM access.organization_member
 * WHERE route = $1 AND organization_id = $2
 *   AND member_account_id = $3 AND valid @> $4::timestamptz
 * LIMIT 1;
 * ```
 *
 * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
 */
export declare const sql: "SELECT role\nFROM access.organization_member\nWHERE route = $1 AND organization_id = $2\n  AND member_account_id = $3 AND valid @> $4::timestamptz\nLIMIT 1 /*file='src%2Faccess%2Faccount-organization-role.sql'*/;";
/**
 * ```sql
 * SELECT role
 * FROM access.organization_member
 * WHERE route = :route AND organization_id = :organization_id
 *   AND member_account_id = :member_account_id AND valid @> :at::timestamptz
 * LIMIT 1;
 * ```
 *
 * The `.sql` file's contents, exactly as written, as the module's `raw` export.
 */
export declare const raw: "SELECT role\nFROM access.organization_member\nWHERE route = :route AND organization_id = :organization_id\n  AND member_account_id = :member_account_id AND valid @> :at::timestamptz\nLIMIT 1;\n";
export declare const params: readonly ["route", "organization_id", "member_account_id", "at"];
/**
 * ```sql
 * SELECT role
 * FROM access.organization_member
 * WHERE route = :route AND organization_id = :organization_id
 *   AND member_account_id = :member_account_id AND valid @> :at::timestamptz
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
     * SELECT role
     * FROM access.organization_member
     * WHERE route = $1 AND organization_id = $2
     *   AND member_account_id = $3 AND valid @> $4::timestamptz
     * LIMIT 1;
     * ```
     *
     * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
     */
    readonly sql: typeof sql;
    /**
     * ```sql
     * SELECT role
     * FROM access.organization_member
     * WHERE route = :route AND organization_id = :organization_id
     *   AND member_account_id = :member_account_id AND valid @> :at::timestamptz
     * LIMIT 1;
     * ```
     *
     * The `.sql` file's contents, exactly as written, as the module's `raw` export.
     */
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
