import type { Query } from "reylo";
export type Params = {
    route: number;
    id: string;
    at: string;
};
export type Row = {
    realm_id: string;
    space_id: string;
    visibility: "public" | "protected";
    context_id: string;
    board_scheme_id: string | null;
    state: "active" | "removed";
    head_revision_id: string;
    created_at: string;
    creator: string;
    ownership_state: string;
    orphaned_at: string | null;
    claim_eligible_at: string | null;
    predecessor: string | null;
    title: string;
    summary: string;
    votes: unknown;
    presentation: unknown;
    revision_created_at: string;
    author: string;
    inserted_here: boolean | null;
};
export type QueryError = import("reylo").QueryError<"postgres">;
/**
 * Materialize the single identity before joining its exact head. Otherwise a
 * reordered join can scan every revision of this Realm before checking the head.
 *
 * ```sql
 * WITH input AS NOT MATERIALIZED (
 *   SELECT $1::integer AS route, $2::uuid AS id, $3::timestamptz AS at
 * ), identity AS MATERIALIZED (
 *   SELECT h.route, realm_id, space_id, visibility, context_id, board_scheme_id, state, head_revision_id, created_at, creator,
 *          ownership_state, orphaned_at, claim_eligible_at,
 *          h.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
 *          i.at
 *   FROM community.realm AS h CROSS JOIN input i
 *   WHERE h.route = i.route AND realm_id = i.id AND state = 'active'
 *     AND EXISTS (SELECT 1 FROM community.space host WHERE host.route=h.route AND host.space_id=h.space_id AND host.state='active')
 * )
 * SELECT s.realm_id, s.space_id, s.visibility, s.context_id, s.board_scheme_id, s.state, s.head_revision_id,
 *        s.created_at::text, s.creator, s.ownership_state, s.orphaned_at::text, s.claim_eligible_at::text, r.predecessor, r.title, r.summary, r.votes, r.presentation,
 *        r.created_at::text AS revision_created_at, r.author,
 *        s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
 * FROM identity s
 * CROSS JOIN input i
 * JOIN community.realm_revision r
 *   ON r.route = i.route AND r.realm_id = s.realm_id AND r.revision_id = s.head_revision_id
 * WHERE s.created_at <= s.at AND r.created_at <= s.at
 * LIMIT 1;
 * ```
 *
 * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
 */
export declare const sql: "-- Materialize the single identity before joining its exact head. Otherwise a\n-- reordered join can scan every revision of this Realm before checking the head.\nWITH input AS NOT MATERIALIZED (\n  SELECT $1::integer AS route, $2::uuid AS id, $3::timestamptz AS at\n), identity AS MATERIALIZED (\n  SELECT h.route, realm_id, space_id, visibility, context_id, board_scheme_id, state, head_revision_id, created_at, creator,\n         ownership_state, orphaned_at, claim_eligible_at,\n         h.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,\n         i.at\n  FROM community.realm AS h CROSS JOIN input i\n  WHERE h.route = i.route AND realm_id = i.id AND state = 'active'\n    AND EXISTS (SELECT 1 FROM community.space host WHERE host.route=h.route AND host.space_id=h.space_id AND host.state='active')\n)\nSELECT s.realm_id, s.space_id, s.visibility, s.context_id, s.board_scheme_id, s.state, s.head_revision_id,\n       s.created_at::text, s.creator, s.ownership_state, s.orphaned_at::text, s.claim_eligible_at::text, r.predecessor, r.title, r.summary, r.votes, r.presentation,\n       r.created_at::text AS revision_created_at, r.author,\n       s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here\nFROM identity s\nCROSS JOIN input i\nJOIN community.realm_revision r\n  ON r.route = i.route AND r.realm_id = s.realm_id AND r.revision_id = s.head_revision_id\nWHERE s.created_at <= s.at AND r.created_at <= s.at\nLIMIT 1 /*file='..%2F..%2F..%2F..%2Fservices%2Fkernel%2Fsrc%2Fcommunity%2Frealm-read.sql'*/;";
/**
 * Materialize the single identity before joining its exact head. Otherwise a
 * reordered join can scan every revision of this Realm before checking the head.
 *
 * ```sql
 * WITH input AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at
 * ), identity AS MATERIALIZED (
 *   SELECT h.route, realm_id, space_id, visibility, context_id, board_scheme_id, state, head_revision_id, created_at, creator,
 *          ownership_state, orphaned_at, claim_eligible_at,
 *          h.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
 *          i.at
 *   FROM community.realm AS h CROSS JOIN input i
 *   WHERE h.route = i.route AND realm_id = i.id AND state = 'active'
 *     AND EXISTS (SELECT 1 FROM community.space host WHERE host.route=h.route AND host.space_id=h.space_id AND host.state='active')
 * )
 * SELECT s.realm_id, s.space_id, s.visibility, s.context_id, s.board_scheme_id, s.state, s.head_revision_id,
 *        s.created_at::text, s.creator, s.ownership_state, s.orphaned_at::text, s.claim_eligible_at::text, r.predecessor, r.title, r.summary, r.votes, r.presentation,
 *        r.created_at::text AS revision_created_at, r.author,
 *        s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
 * FROM identity s
 * CROSS JOIN input i
 * JOIN community.realm_revision r
 *   ON r.route = i.route AND r.realm_id = s.realm_id AND r.revision_id = s.head_revision_id
 * WHERE s.created_at <= s.at AND r.created_at <= s.at
 * LIMIT 1;
 * ```
 *
 * The `.sql` file's contents, exactly as written, as the module's `raw` export.
 */
export declare const raw: "-- Materialize the single identity before joining its exact head. Otherwise a\n-- reordered join can scan every revision of this Realm before checking the head.\nWITH input AS NOT MATERIALIZED (\n  SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at\n), identity AS MATERIALIZED (\n  SELECT h.route, realm_id, space_id, visibility, context_id, board_scheme_id, state, head_revision_id, created_at, creator,\n         ownership_state, orphaned_at, claim_eligible_at,\n         h.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,\n         i.at\n  FROM community.realm AS h CROSS JOIN input i\n  WHERE h.route = i.route AND realm_id = i.id AND state = 'active'\n    AND EXISTS (SELECT 1 FROM community.space host WHERE host.route=h.route AND host.space_id=h.space_id AND host.state='active')\n)\nSELECT s.realm_id, s.space_id, s.visibility, s.context_id, s.board_scheme_id, s.state, s.head_revision_id,\n       s.created_at::text, s.creator, s.ownership_state, s.orphaned_at::text, s.claim_eligible_at::text, r.predecessor, r.title, r.summary, r.votes, r.presentation,\n       r.created_at::text AS revision_created_at, r.author,\n       s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here\nFROM identity s\nCROSS JOIN input i\nJOIN community.realm_revision r\n  ON r.route = i.route AND r.realm_id = s.realm_id AND r.revision_id = s.head_revision_id\nWHERE s.created_at <= s.at AND r.created_at <= s.at\nLIMIT 1;\n";
export declare const params: readonly ["route", "id", "at"];
/**
 * Materialize the single identity before joining its exact head. Otherwise a
 * reordered join can scan every revision of this Realm before checking the head.
 *
 * ```sql
 * WITH input AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at
 * ), identity AS MATERIALIZED (
 *   SELECT h.route, realm_id, space_id, visibility, context_id, board_scheme_id, state, head_revision_id, created_at, creator,
 *          ownership_state, orphaned_at, claim_eligible_at,
 *          h.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
 *          i.at
 *   FROM community.realm AS h CROSS JOIN input i
 *   WHERE h.route = i.route AND realm_id = i.id AND state = 'active'
 *     AND EXISTS (SELECT 1 FROM community.space host WHERE host.route=h.route AND host.space_id=h.space_id AND host.state='active')
 * )
 * SELECT s.realm_id, s.space_id, s.visibility, s.context_id, s.board_scheme_id, s.state, s.head_revision_id,
 *        s.created_at::text, s.creator, s.ownership_state, s.orphaned_at::text, s.claim_eligible_at::text, r.predecessor, r.title, r.summary, r.votes, r.presentation,
 *        r.created_at::text AS revision_created_at, r.author,
 *        s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
 * FROM identity s
 * CROSS JOIN input i
 * JOIN community.realm_revision r
 *   ON r.route = i.route AND r.realm_id = s.realm_id AND r.revision_id = s.head_revision_id
 * WHERE s.created_at <= s.at AND r.created_at <= s.at
 * LIMIT 1;
 * ```
 */
declare const query: Query<{
    route: number;
    id: string;
    at: string;
}, {
    realm_id: string;
    space_id: string;
    visibility: "public" | "protected";
    context_id: string;
    board_scheme_id: string | null;
    state: "active" | "removed";
    head_revision_id: string;
    created_at: string;
    creator: string;
    ownership_state: string;
    orphaned_at: string | null;
    claim_eligible_at: string | null;
    predecessor: string | null;
    title: string;
    summary: string;
    votes: unknown;
    presentation: unknown;
    revision_created_at: string;
    author: string;
    inserted_here: boolean | null;
}, "maybeOne", "postgres", QueryError> & {
    /**
     * Materialize the single identity before joining its exact head. Otherwise a
     * reordered join can scan every revision of this Realm before checking the head.
     *
     * ```sql
     * WITH input AS NOT MATERIALIZED (
     *   SELECT $1::integer AS route, $2::uuid AS id, $3::timestamptz AS at
     * ), identity AS MATERIALIZED (
     *   SELECT h.route, realm_id, space_id, visibility, context_id, board_scheme_id, state, head_revision_id, created_at, creator,
     *          ownership_state, orphaned_at, claim_eligible_at,
     *          h.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
     *          i.at
     *   FROM community.realm AS h CROSS JOIN input i
     *   WHERE h.route = i.route AND realm_id = i.id AND state = 'active'
     *     AND EXISTS (SELECT 1 FROM community.space host WHERE host.route=h.route AND host.space_id=h.space_id AND host.state='active')
     * )
     * SELECT s.realm_id, s.space_id, s.visibility, s.context_id, s.board_scheme_id, s.state, s.head_revision_id,
     *        s.created_at::text, s.creator, s.ownership_state, s.orphaned_at::text, s.claim_eligible_at::text, r.predecessor, r.title, r.summary, r.votes, r.presentation,
     *        r.created_at::text AS revision_created_at, r.author,
     *        s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
     * FROM identity s
     * CROSS JOIN input i
     * JOIN community.realm_revision r
     *   ON r.route = i.route AND r.realm_id = s.realm_id AND r.revision_id = s.head_revision_id
     * WHERE s.created_at <= s.at AND r.created_at <= s.at
     * LIMIT 1;
     * ```
     *
     * The statement as Reylo sends it to the database, as the module's `sql` export: `:id` is `$1` on Postgres and `?` on MySQL and SQLite, each cast is the dialect's own, and a comment naming the file ends it.
     */
    readonly sql: typeof sql;
    /**
     * Materialize the single identity before joining its exact head. Otherwise a
     * reordered join can scan every revision of this Realm before checking the head.
     *
     * ```sql
     * WITH input AS NOT MATERIALIZED (
     *   SELECT :route::integer AS route, :id::uuid AS id, :at::timestamptz AS at
     * ), identity AS MATERIALIZED (
     *   SELECT h.route, realm_id, space_id, visibility, context_id, board_scheme_id, state, head_revision_id, created_at, creator,
     *          ownership_state, orphaned_at, claim_eligible_at,
     *          h.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
     *          i.at
     *   FROM community.realm AS h CROSS JOIN input i
     *   WHERE h.route = i.route AND realm_id = i.id AND state = 'active'
     *     AND EXISTS (SELECT 1 FROM community.space host WHERE host.route=h.route AND host.space_id=h.space_id AND host.state='active')
     * )
     * SELECT s.realm_id, s.space_id, s.visibility, s.context_id, s.board_scheme_id, s.state, s.head_revision_id,
     *        s.created_at::text, s.creator, s.ownership_state, s.orphaned_at::text, s.claim_eligible_at::text, r.predecessor, r.title, r.summary, r.votes, r.presentation,
     *        r.created_at::text AS revision_created_at, r.author,
     *        s.inserted_here AND r.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
     * FROM identity s
     * CROSS JOIN input i
     * JOIN community.realm_revision r
     *   ON r.route = i.route AND r.realm_id = s.realm_id AND r.revision_id = s.head_revision_id
     * WHERE s.created_at <= s.at AND r.created_at <= s.at
     * LIMIT 1;
     * ```
     *
     * The `.sql` file's contents, exactly as written, as the module's `raw` export.
     */
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
