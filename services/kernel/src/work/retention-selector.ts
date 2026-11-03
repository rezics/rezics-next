import type { Pool } from 'pg';
import type { WorkflowRetentionSelector } from './retention.ts';
import selectTerminal from './retention-select.sql';

export const WORKFLOW_RETENTION_SELECTOR_INDEX = 'workflow_retention_selector';

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
