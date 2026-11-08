import type { Query } from "reylo";
export type Params = {
    route: number;
    account_id: string;
    transaction_id: string;
    copy_id: string;
    deletion_id: string;
    revision: number;
    time: string;
};
export type Row = {
    id: string;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "WITH input AS NOT MATERIALIZED (\n  SELECT $1::integer AS route, $2::uuid AS account_id\n), destination AS MATERIALIZED (\n  SELECT jsonb_build_object('provenance', 'legacy', 'releaseDigest', profile_migration_digest,\n    'acceptingType', NULL, 'profileId', 'legacy-fixed-v1') AS pin\n  FROM library.fact_source_head\n  WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input)\n    AND profile_migration_digest IS NOT NULL\n)\nUPDATE library.copy\nSET deletion_id = NULL, deleted_at = NULL, restore_until = NULL,\n    library_profile_pin = COALESCE(library_profile_pin, (SELECT pin FROM destination)),\n    kind_profile_pin = CASE WHEN library_profile_pin IS NULL\n      THEN COALESCE(kind_profile_pin, (SELECT pin FROM destination)) ELSE kind_profile_pin END,\n    status_profile_pin = CASE WHEN library_profile_pin IS NULL\n      THEN COALESCE(status_profile_pin, (SELECT pin FROM destination)) ELSE status_profile_pin END,\n    kind = CASE WHEN library_profile_pin IS NULL AND EXISTS (SELECT 1 FROM destination)\n      THEN COALESCE(kind, 'legacy-unspecified') ELSE kind END,\n    revision = revision + 1, transaction_id = $3::uuid\nWHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input) AND copy_id = $4::uuid\n  AND deletion_id = $5::uuid AND revision = $6::integer\n  AND $7::timestamptz < restore_until\nRETURNING copy_id AS id;";
export declare const raw: "WITH input AS NOT MATERIALIZED (\n  SELECT :route::integer AS route, :account_id::uuid AS account_id\n), destination AS MATERIALIZED (\n  SELECT jsonb_build_object('provenance', 'legacy', 'releaseDigest', profile_migration_digest,\n    'acceptingType', NULL, 'profileId', 'legacy-fixed-v1') AS pin\n  FROM library.fact_source_head\n  WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input)\n    AND profile_migration_digest IS NOT NULL\n)\nUPDATE library.copy\nSET deletion_id = NULL, deleted_at = NULL, restore_until = NULL,\n    library_profile_pin = COALESCE(library_profile_pin, (SELECT pin FROM destination)),\n    kind_profile_pin = CASE WHEN library_profile_pin IS NULL\n      THEN COALESCE(kind_profile_pin, (SELECT pin FROM destination)) ELSE kind_profile_pin END,\n    status_profile_pin = CASE WHEN library_profile_pin IS NULL\n      THEN COALESCE(status_profile_pin, (SELECT pin FROM destination)) ELSE status_profile_pin END,\n    kind = CASE WHEN library_profile_pin IS NULL AND EXISTS (SELECT 1 FROM destination)\n      THEN COALESCE(kind, 'legacy-unspecified') ELSE kind END,\n    revision = revision + 1, transaction_id = :transaction_id::uuid\nWHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input) AND copy_id = :copy_id::uuid\n  AND deletion_id = :deletion_id::uuid AND revision = :revision::integer\n  AND :time::timestamptz < restore_until\nRETURNING copy_id AS id;\n";
export declare const params: readonly ["route", "account_id", "transaction_id", "copy_id", "deletion_id", "revision", "time"];
/**
 * ```sql
 * WITH input AS NOT MATERIALIZED (
 *   SELECT :route::integer AS route, :account_id::uuid AS account_id
 * ), destination AS MATERIALIZED (
 *   SELECT jsonb_build_object('provenance', 'legacy', 'releaseDigest', profile_migration_digest,
 *     'acceptingType', NULL, 'profileId', 'legacy-fixed-v1') AS pin
 *   FROM library.fact_source_head
 *   WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input)
 *     AND profile_migration_digest IS NOT NULL
 * )
 * UPDATE library.copy
 * SET deletion_id = NULL, deleted_at = NULL, restore_until = NULL,
 *     library_profile_pin = COALESCE(library_profile_pin, (SELECT pin FROM destination)),
 *     kind_profile_pin = CASE WHEN library_profile_pin IS NULL
 *       THEN COALESCE(kind_profile_pin, (SELECT pin FROM destination)) ELSE kind_profile_pin END,
 *     status_profile_pin = CASE WHEN library_profile_pin IS NULL
 *       THEN COALESCE(status_profile_pin, (SELECT pin FROM destination)) ELSE status_profile_pin END,
 *     kind = CASE WHEN library_profile_pin IS NULL AND EXISTS (SELECT 1 FROM destination)
 *       THEN COALESCE(kind, 'legacy-unspecified') ELSE kind END,
 *     revision = revision + 1, transaction_id = :transaction_id::uuid
 * WHERE route = (SELECT route FROM input) AND account_id = (SELECT account_id FROM input) AND copy_id = :copy_id::uuid
 *   AND deletion_id = :deletion_id::uuid AND revision = :revision::integer
 *   AND :time::timestamptz < restore_until
 * RETURNING copy_id AS id;
 * ```
 */
declare const query: Query<{
    route: number;
    account_id: string;
    transaction_id: string;
    copy_id: string;
    deletion_id: string;
    revision: number;
    time: string;
}, {
    id: string;
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
