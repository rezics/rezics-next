import type { Pool } from 'pg';
import {
  WORKFLOW_RETENTION_PAYLOAD_FAMILIES,
  WORKFLOW_RETENTION_SELECTOR_INDEX,
  WORKFLOW_RETENTION_SELECT_TAG,
  WORKFLOW_RETENTION_WRITER_FENCE_TABLE,
} from './contract/bounds.ts';
import {
  byteInventoriesMatch,
  emptyWorkflowRetentionBytes,
  emptyWorkflowRetentionInventory,
  inventoriesMatch,
  workflowRetentionBytes,
  workflowRetentionInventory,
  type WorkflowRetentionByteInventory,
  type WorkflowRetentionPayloadInventory,
  type WorkflowRetentionSelection,
} from './core/index.ts';
import type { WorkflowRetentionSelector } from './retention.ts';
import countOwnedFences from './retention-fence-count.sql';
import countOwnedPayload from './retention-payload-count.sql';
import selectTerminal from './retention-select.sql';

export { WORKFLOW_RETENTION_SELECTOR_INDEX, WORKFLOW_RETENTION_SELECT_TAG, WORKFLOW_RETENTION_WRITER_FENCE_TABLE };
export { WORKFLOW_RETENTION_PAYLOAD_FAMILIES };

export type WorkflowRetentionOwnedSnapshot = Readonly<{
  rows: WorkflowRetentionPayloadInventory;
  bytes: WorkflowRetentionByteInventory;
  fences: number;
}>;

/** Indexed terminal selection against the installed dbos.workflow_status table. */
export function createWorkflowRetentionSelector(pool: Pick<Pool, 'query'>): WorkflowRetentionSelector {
  return async (input) => {
    const rows = await selectTerminal.run(pool, {
      application_name: input.applicationName,
      completed_before: input.completedBefore,
      limit: input.limit,
    });
    return rows.map((row) => row.workflow_uuid);
  };
}

export function retentionSelectorBinds(input: WorkflowRetentionSelection): {
  readonly application_name: string;
  readonly completed_before: number;
  readonly limit: number;
} {
  return {
    application_name: input.applicationName,
    completed_before: input.completedBefore,
    limit: input.limit,
  };
}

function payloadFrom(row: {
  readonly workflow_status?: string | number | bigint | null;
  readonly workflow_input?: string | number | bigint | null;
  readonly workflow_output?: string | number | bigint | null;
  readonly operation_outputs?: string | number | bigint | null;
  readonly workflow_events?: string | number | bigint | null;
  readonly workflow_events_history?: string | number | bigint | null;
  readonly notifications?: string | number | bigint | null;
  readonly streams?: string | number | bigint | null;
}): WorkflowRetentionPayloadInventory {
  return workflowRetentionInventory({
    workflow_status: Number(row.workflow_status ?? 0),
    workflow_input: Number(row.workflow_input ?? 0),
    workflow_output: Number(row.workflow_output ?? 0),
    operation_outputs: Number(row.operation_outputs ?? 0),
    workflow_events: Number(row.workflow_events ?? 0),
    workflow_events_history: Number(row.workflow_events_history ?? 0),
    notifications: Number(row.notifications ?? 0),
    streams: Number(row.streams ?? 0),
  });
}

function bytesFrom(row: {
  readonly workflow_status_bytes?: string | number | bigint | null;
  readonly workflow_input_bytes?: string | number | bigint | null;
  readonly workflow_output_bytes?: string | number | bigint | null;
  readonly operation_outputs_bytes?: string | number | bigint | null;
  readonly workflow_events_bytes?: string | number | bigint | null;
  readonly workflow_events_history_bytes?: string | number | bigint | null;
  readonly notifications_bytes?: string | number | bigint | null;
  readonly streams_bytes?: string | number | bigint | null;
}): WorkflowRetentionByteInventory {
  return workflowRetentionBytes({
    workflow_status: Number(row.workflow_status_bytes ?? 0),
    workflow_input: Number(row.workflow_input_bytes ?? 0),
    workflow_output: Number(row.workflow_output_bytes ?? 0),
    operation_outputs: Number(row.operation_outputs_bytes ?? 0),
    workflow_events: Number(row.workflow_events_bytes ?? 0),
    workflow_events_history: Number(row.workflow_events_history_bytes ?? 0),
    notifications: Number(row.notifications_bytes ?? 0),
    streams: Number(row.streams_bytes ?? 0),
  });
}

export async function readWorkflowRetentionPayload(
  pool: Pick<Pool, 'query'>,
  ids: readonly string[],
): Promise<WorkflowRetentionPayloadInventory> {
  if (ids.length === 0) return emptyWorkflowRetentionInventory();
  const result = await countOwnedPayload.run(pool, { ids: [...ids] });
  const row = Array.isArray(result) ? result[0] : result;
  if (!row) return emptyWorkflowRetentionInventory();
  return payloadFrom(row);
}

export async function readWorkflowRetentionPayloadBytes(
  pool: Pick<Pool, 'query'>,
  ids: readonly string[],
): Promise<WorkflowRetentionByteInventory> {
  if (ids.length === 0) return emptyWorkflowRetentionBytes();
  const result = await countOwnedPayload.run(pool, { ids: [...ids] });
  const row = Array.isArray(result) ? result[0] : result;
  if (!row) return emptyWorkflowRetentionBytes();
  return bytesFrom(row);
}

export async function readWorkflowRetentionOwned(
  pool: Pick<Pool, 'query'>,
  ids: readonly string[],
): Promise<WorkflowRetentionOwnedSnapshot> {
  if (ids.length === 0) {
    return { rows: emptyWorkflowRetentionInventory(), bytes: emptyWorkflowRetentionBytes(), fences: 0 };
  }
  const [payload, fences] = await Promise.all([
    countOwnedPayload.run(pool, { ids: [...ids] }),
    countOwnedFences.run(pool, { ids: [...ids] }),
  ]);
  const row = Array.isArray(payload) ? payload[0] : payload;
  const fenceRow = Array.isArray(fences) ? fences[0] : fences;
  if (!row) {
    return {
      rows: emptyWorkflowRetentionInventory(),
      bytes: emptyWorkflowRetentionBytes(),
      fences: Number(fenceRow?.n ?? 0),
    };
  }
  return {
    rows: payloadFrom(row),
    bytes: bytesFrom(row),
    fences: Number(fenceRow?.n ?? 0),
  };
}

export async function readWorkflowRetentionFences(pool: Pick<Pool, 'query'>, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await countOwnedFences.run(pool, { ids: [...ids] });
  const row = Array.isArray(result) ? result[0] : result;
  return Number(row?.n ?? 0);
}

export function emptyWorkflowRetentionOwned(): WorkflowRetentionOwnedSnapshot {
  return { rows: emptyWorkflowRetentionInventory(), bytes: emptyWorkflowRetentionBytes(), fences: 0 };
}

export function ownedSnapshotsMatch(
  actual: WorkflowRetentionOwnedSnapshot,
  expected: WorkflowRetentionOwnedSnapshot,
): boolean {
  return (
    inventoriesMatch(actual.rows, expected.rows) &&
    byteInventoriesMatch(actual.bytes, expected.bytes) &&
    actual.fences === expected.fences
  );
}
