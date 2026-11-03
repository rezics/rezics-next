import type { Query } from "reylo";
export type Params = {
    question_id: string;
};
export type Row = {
    id: string;
    ownerId: string | null;
    realmId: string | null;
    meaning: string | null;
    revision: number;
    label: string;
    grain: "work" | "release" | "episode" | "character";
    minimumUnits: number;
    maximumUnits: number;
    stepUnits: number;
};
export type QueryError = import("reylo").QueryError<"postgres">;
/**
 * ```sql
 * SELECT id, owner_id AS "ownerId", realm_id AS "realmId", meaning, revision, label, grain, minimum_units AS "minimumUnits",
 *        maximum_units AS "maximumUnits", step_units AS "stepUnits"
 * FROM rating.question
 * WHERE id = $1::uuid;
 * ```
 *
 * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
 */
export declare const sql: "SELECT id, owner_id AS \"ownerId\", realm_id AS \"realmId\", meaning, revision, label, grain, minimum_units AS \"minimumUnits\",\n       maximum_units AS \"maximumUnits\", step_units AS \"stepUnits\"\nFROM rating.question\nWHERE id = $1::uuid /*file='src%2Frating%2Fquestion-read.sql'*/;";
/**
 * ```sql
 * SELECT id, owner_id AS "ownerId", realm_id AS "realmId", meaning, revision, label, grain, minimum_units AS "minimumUnits",
 *        maximum_units AS "maximumUnits", step_units AS "stepUnits"
 * FROM rating.question
 * WHERE id = :question_id::uuid;
 * ```
 *
 * The `.sql` file's contents, exactly as written, as the module's `raw` export.
 */
export declare const raw: "SELECT id, owner_id AS \"ownerId\", realm_id AS \"realmId\", meaning, revision, label, grain, minimum_units AS \"minimumUnits\",\n       maximum_units AS \"maximumUnits\", step_units AS \"stepUnits\"\nFROM rating.question\nWHERE id = :question_id::uuid;\n";
export declare const params: readonly ["question_id"];
/**
 * ```sql
 * SELECT id, owner_id AS "ownerId", realm_id AS "realmId", meaning, revision, label, grain, minimum_units AS "minimumUnits",
 *        maximum_units AS "maximumUnits", step_units AS "stepUnits"
 * FROM rating.question
 * WHERE id = :question_id::uuid;
 * ```
 */
declare const query: Query<{
    question_id: string;
}, {
    id: string;
    ownerId: string | null;
    realmId: string | null;
    meaning: string | null;
    revision: number;
    label: string;
    grain: "work" | "release" | "episode" | "character";
    minimumUnits: number;
    maximumUnits: number;
    stepUnits: number;
}, "maybeOne", "postgres", QueryError> & {
    /**
     * ```sql
     * SELECT id, owner_id AS "ownerId", realm_id AS "realmId", meaning, revision, label, grain, minimum_units AS "minimumUnits",
     *        maximum_units AS "maximumUnits", step_units AS "stepUnits"
     * FROM rating.question
     * WHERE id = $1::uuid;
     * ```
     *
     * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
     */
    readonly sql: typeof sql;
    /**
     * ```sql
     * SELECT id, owner_id AS "ownerId", realm_id AS "realmId", meaning, revision, label, grain, minimum_units AS "minimumUnits",
     *        maximum_units AS "maximumUnits", step_units AS "stepUnits"
     * FROM rating.question
     * WHERE id = :question_id::uuid;
     * ```
     *
     * The `.sql` file's contents, exactly as written, as the module's `raw` export.
     */
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
