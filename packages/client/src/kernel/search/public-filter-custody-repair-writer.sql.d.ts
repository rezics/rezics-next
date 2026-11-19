import type { Query } from "reylo";
export type Params = {
    partition_no: number;
    physical_target: string;
    original_id: string;
};
export type Row = {
    writer_token: string | null;
    dispatch_state: "enrolled" | "dispatched" | "settled" | "cancelled";
    closed_job: string | null;
    repair_locator: string | null;
    repair_action: string | null;
    repair_receipt: string | null;
    owner_epoch: number;
    incarnation: string;
    source_position: bigint | null;
    visible_position: bigint | null;
    visible_transaction_id: string | null;
    settled_position: bigint | null;
    settled_transaction_id: string | null;
    writer_transaction_id: string | null;
    writer_position: bigint | null;
};
export type QueryError = import("reylo").QueryError<"postgres">;
export declare const sql: "SELECT writer_token,dispatch_state,closed_job,repair_locator,repair_action,repair_receipt,\n  owner_epoch,incarnation,source_position,visible_position,visible_transaction_id,\n  settled_position,settled_transaction_id,writer_transaction_id,writer_position\nFROM search.identity_writer\nWHERE partition_no=$1::integer AND physical_target=$2::text AND original_id=$3::uuid FOR SHARE;";
export declare const raw: "SELECT writer_token,dispatch_state,closed_job,repair_locator,repair_action,repair_receipt,\n  owner_epoch,incarnation,source_position,visible_position,visible_transaction_id,\n  settled_position,settled_transaction_id,writer_transaction_id,writer_position\nFROM search.identity_writer\nWHERE partition_no=:partition_no::integer AND physical_target=:physical_target::text AND original_id=:original_id::uuid FOR SHARE;\n";
export declare const params: readonly ["partition_no", "physical_target", "original_id"];
/**
 * ```sql
 * SELECT writer_token,dispatch_state,closed_job,repair_locator,repair_action,repair_receipt,
 *   owner_epoch,incarnation,source_position,visible_position,visible_transaction_id,
 *   settled_position,settled_transaction_id,writer_transaction_id,writer_position
 * FROM search.identity_writer
 * WHERE partition_no=:partition_no::integer AND physical_target=:physical_target::text AND original_id=:original_id::uuid FOR SHARE;
 * ```
 */
declare const query: Query<{
    partition_no: number;
    physical_target: string;
    original_id: string;
}, {
    writer_token: string | null;
    dispatch_state: "enrolled" | "dispatched" | "settled" | "cancelled";
    closed_job: string | null;
    repair_locator: string | null;
    repair_action: string | null;
    repair_receipt: string | null;
    owner_epoch: number;
    incarnation: string;
    source_position: bigint | null;
    visible_position: bigint | null;
    visible_transaction_id: string | null;
    settled_position: bigint | null;
    settled_transaction_id: string | null;
    writer_transaction_id: string | null;
    writer_position: bigint | null;
}, "maybeOne", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
