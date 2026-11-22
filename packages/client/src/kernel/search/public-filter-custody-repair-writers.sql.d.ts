import type { Json, Query } from "reylo";
export type Params = {
    subjects: Json;
    physical_target: string;
};
export type Row = {
    original_id: string | null;
    writer_token: string | null;
    dispatch_state: "enrolled" | "dispatched" | "settled" | "cancelled";
    closed_job: string | null;
    repair_locator: string | null;
    repair_action: string | null;
    repair_receipt: string | null;
    repair_account: string | null;
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
export declare const sql: "SELECT key.original_id::text,writer.* FROM jsonb_to_recordset($1::jsonb) AS key(partition_no integer,original_id uuid)\nJOIN LATERAL (\n  SELECT writer_token,dispatch_state,closed_job,repair_locator,repair_action,repair_receipt,repair_account,\n    owner_epoch,incarnation,source_position,visible_position,visible_transaction_id,\n    settled_position,settled_transaction_id,writer_transaction_id,writer_position\n  FROM search.identity_writer AS w\n  WHERE (w.partition_no,w.physical_target,w.original_id)=(key.partition_no,$2::text,key.original_id)\n  FOR SHARE\n) writer ON true ORDER BY key.partition_no,key.original_id;";
export declare const raw: "SELECT key.original_id::text,writer.* FROM jsonb_to_recordset(:subjects::jsonb) AS key(partition_no integer,original_id uuid)\nJOIN LATERAL (\n  SELECT writer_token,dispatch_state,closed_job,repair_locator,repair_action,repair_receipt,repair_account,\n    owner_epoch,incarnation,source_position,visible_position,visible_transaction_id,\n    settled_position,settled_transaction_id,writer_transaction_id,writer_position\n  FROM search.identity_writer AS w\n  WHERE (w.partition_no,w.physical_target,w.original_id)=(key.partition_no,:physical_target::text,key.original_id)\n  FOR SHARE\n) writer ON true ORDER BY key.partition_no,key.original_id;\n";
export declare const params: readonly ["subjects", "physical_target"];
/**
 * ```sql
 * SELECT key.original_id::text,writer.* FROM jsonb_to_recordset(:subjects::jsonb) AS key(partition_no integer,original_id uuid)
 * JOIN LATERAL (
 *   SELECT writer_token,dispatch_state,closed_job,repair_locator,repair_action,repair_receipt,repair_account,
 *     owner_epoch,incarnation,source_position,visible_position,visible_transaction_id,
 *     settled_position,settled_transaction_id,writer_transaction_id,writer_position
 *   FROM search.identity_writer AS w
 *   WHERE (w.partition_no,w.physical_target,w.original_id)=(key.partition_no,:physical_target::text,key.original_id)
 *   FOR SHARE
 * ) writer ON true ORDER BY key.partition_no,key.original_id;
 * ```
 */
declare const query: Query<{
    subjects: Json;
    physical_target: string;
}, {
    original_id: string | null;
    writer_token: string | null;
    dispatch_state: "enrolled" | "dispatched" | "settled" | "cancelled";
    closed_job: string | null;
    repair_locator: string | null;
    repair_action: string | null;
    repair_receipt: string | null;
    repair_account: string | null;
    owner_epoch: number;
    incarnation: string;
    source_position: bigint | null;
    visible_position: bigint | null;
    visible_transaction_id: string | null;
    settled_position: bigint | null;
    settled_transaction_id: string | null;
    writer_transaction_id: string | null;
    writer_position: bigint | null;
}, "many", "postgres", QueryError> & {
    readonly sql: typeof sql;
    readonly raw: typeof raw;
    readonly source: string;
};
export default query;
