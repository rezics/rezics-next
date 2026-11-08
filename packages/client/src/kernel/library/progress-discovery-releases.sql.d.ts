import type { Json, Query } from "reylo";
export type Params = {
    digests: string[];
};
export type Row = {
    digest: string;
    body: Json;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT digest, body\nFROM semantic.definition_release\nWHERE route = 0 AND digest = ANY($1::text[])\nORDER BY digest\nLIMIT 50;";
export declare const raw: "SELECT digest, body\nFROM semantic.definition_release\nWHERE route = 0 AND digest = ANY(:digests::text[])\nORDER BY digest\nLIMIT 50;\n";
export declare const params: readonly ["digests"];
/**
 * ```sql
 * SELECT digest, body
 * FROM semantic.definition_release
 * WHERE route = 0 AND digest = ANY(:digests::text[])
 * ORDER BY digest
 * LIMIT 50;
 * ```
 */
declare const query: Query<{
    digests: string[];
}, {
    digest: string;
    body: Json;
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
