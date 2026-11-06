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
    lifecycleState: string;
    lifecycleRevision: number;
    presentationLabel: string | null;
    labelRevision: number | null;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT q.id, q.owner_id AS \"ownerId\", q.realm_id AS \"realmId\", q.meaning, q.revision, q.label,\n       q.grain, q.minimum_units AS \"minimumUnits\", q.maximum_units AS \"maximumUnits\", q.step_units AS \"stepUnits\",\n       COALESCE(lifecycle.state, 'active') AS \"lifecycleState\",\n       COALESCE(lifecycle.revision, 1) AS \"lifecycleRevision\",\n       h.label AS \"presentationLabel\", h.revision AS \"labelRevision\"\nFROM rating.question q\nLEFT JOIN rating.question_label_head h ON h.question_id = q.id\nLEFT JOIN rating.question_lifecycle lifecycle ON lifecycle.question_id = q.id\nWHERE q.id = $1::uuid;";
export declare const raw: "SELECT q.id, q.owner_id AS \"ownerId\", q.realm_id AS \"realmId\", q.meaning, q.revision, q.label,\n       q.grain, q.minimum_units AS \"minimumUnits\", q.maximum_units AS \"maximumUnits\", q.step_units AS \"stepUnits\",\n       COALESCE(lifecycle.state, 'active') AS \"lifecycleState\",\n       COALESCE(lifecycle.revision, 1) AS \"lifecycleRevision\",\n       h.label AS \"presentationLabel\", h.revision AS \"labelRevision\"\nFROM rating.question q\nLEFT JOIN rating.question_label_head h ON h.question_id = q.id\nLEFT JOIN rating.question_lifecycle lifecycle ON lifecycle.question_id = q.id\nWHERE q.id = :question_id::uuid;\n";
export declare const params: readonly ["question_id"];
/**
 * ```sql
 * SELECT q.id, q.owner_id AS "ownerId", q.realm_id AS "realmId", q.meaning, q.revision, q.label,
 *        q.grain, q.minimum_units AS "minimumUnits", q.maximum_units AS "maximumUnits", q.step_units AS "stepUnits",
 *        COALESCE(lifecycle.state, 'active') AS "lifecycleState",
 *        COALESCE(lifecycle.revision, 1) AS "lifecycleRevision",
 *        h.label AS "presentationLabel", h.revision AS "labelRevision"
 * FROM rating.question q
 * LEFT JOIN rating.question_label_head h ON h.question_id = q.id
 * LEFT JOIN rating.question_lifecycle lifecycle ON lifecycle.question_id = q.id
 * WHERE q.id = :question_id::uuid;
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
    lifecycleState: string;
    lifecycleRevision: number;
    presentationLabel: string | null;
    labelRevision: number | null;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
