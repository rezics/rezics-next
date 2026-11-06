/** Identity SQL catalog. Core owns arithmetic; composition binds this catalog to the application. */
import type { IdentityNativeCatalog } from '../contract/index.ts';
export declare const nativeIdentityPartitionQuery: Readonly<{
    sql: "SELECT epoch, position::text AS position, write_state AS \"writeState\",\n    CASE WHEN moved_to IS NULL THEN NULL ELSE '' END AS \"movedTo\"\n    FROM core.partition WHERE partition_no=$1 FOR SHARE";
    params: readonly string[];
}>;
export declare const libraryIdentityJobSizeSQL = "SELECT octet_length(intent::text) AS bytes FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3";
export declare function createIdentityNativeCatalog(): IdentityNativeCatalog;
