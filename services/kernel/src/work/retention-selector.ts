import type { Pool } from 'pg';
import {
  WORKFLOW_RETENTION_PAYLOAD_FAMILIES,
  WORKFLOW_RETENTION_SELECTOR_INDEX,
  WORKFLOW_RETENTION_SELECT_TAG,
  WORKFLOW_RETENTION_WRITER_FENCE_TABLE,
} from './contract/bounds.ts';
import {
  emptyWorkflowRetentionInventory,
  workflowRetentionInventory,
  type WorkflowRetentionPayloadInventory,
  type WorkflowRetentionSelection,
} from './core/index.ts';
import type { WorkflowRetentionSelector } from './retention.ts';
import countOwnedFences from './retention-fence-count.sql';
import countOwnedPayload from './retention-payload-count.sql';
import selectTerminal from './retention-select.sql';

export { WORKFLOW_RETENTION_SELECTOR_INDEX, WORKFLOW_RETENTION_SELECT_TAG, WORKFLOW_RETENTION_WRITER_FENCE_TABLE };
export { WORKFLOW_RETENTION_PAYLOAD_FAMILIES };

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

export async function readWorkflowRetentionPayload(
  pool: Pick<Pool, 'query'>,
  ids: readonly string[],
): Promise<WorkflowRetentionPayloadInventory> {
  if (ids.length === 0) return emptyWorkflowRetentionInventory();
  const result = await countOwnedPayload.run(pool, { ids: [...ids] });
  const row = Array.isArray(result) ? result[0] : result;
  if (!row) return emptyWorkflowRetentionInventory();
  return workflowRetentionInventory({
    workflow_status: Number(row.workflow_status),
    workflow_input: Number(row.workflow_input),
    workflow_output: Number(row.workflow_output),
    operation_outputs: Number(row.operation_outputs),
    workflow_events: Number(row.workflow_events),
    workflow_events_history: Number(row.workflow_events_history),
    notifications: Number(row.notifications),
    streams: Number(row.streams),
  });
}

export async function readWorkflowRetentionFences(
  pool: Pick<Pool, 'query'>,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await countOwnedFences.run(pool, { ids: [...ids] });
  const row = Array.isArray(result) ? result[0] : result;
  return Number(row?.n ?? 0);
}
