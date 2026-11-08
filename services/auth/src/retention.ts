import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { createWorkflowRetention } from './application/index.ts';
import { workflowRetentionStore } from './retention-store.ts';
import { workflowRetentionScan } from './adapters/workflow-retention.ts';
import type { WorkflowStatusScanContinuation } from './retention-scan.ts';
import { deleteAuthSdkTechnical } from './sdk-retirement-fence.ts';
import type { AuthRetentionInvocation, WorkflowCopyRetirement, WorkflowRetentionPage } from './contract/index.ts';

export {
  AUTH_WORKFLOW_APPLICATION,
  WorkflowRetentionConfigurationError,
  WORKFLOW_RETENTION_WORKFLOW,
  WORKFLOW_RETENTION_SCHEDULE,
  WORKFLOW_RETENTION_SCHEDULE_EXPRESSION,
  DEFAULT_WORKFLOW_RETENTION_DAYS,
  MIN_WORKFLOW_RETENTION_DAYS,
  MAX_WORKFLOW_RETENTION_DAYS,
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_MAX_BATCHES,
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowRetentionConfig,
  type WorkflowCopyRetirement,
  type WorkflowRetentionPage,
} from './contract/index.ts';
export { readWorkflowRetentionConfig, AUTH_WORKFLOW_RETENTION_COST } from './core/index.ts';
export { installWorkflowRequestRetention } from './adapters/request-retention.ts';
export type WorkflowRetentionSdk = Pick<typeof DBOS, 'openWorkflowStatusScan' | 'readWorkflowStatusScanPage'>;

/** Auth assembly supplies the existing native consumer/SDK retirement capability.
 * This composition creates no writer, ledger, scheduler or second SDK runtime.
 */
export function createAuthWorkflowRetention(
  database: Pool,
  retireCopy: WorkflowCopyRetirement,
  sdk: WorkflowRetentionSdk = DBOS,
  now: () => number = Date.now,
) {
  return createWorkflowRetention({
    store: workflowRetentionStore<WorkflowStatusScanContinuation>(database),
    scan: workflowRetentionScan(sdk),
    retireCopy,
    deleteTechnical: deleteAuthSdkTechnical,
    now,
  });
}

/** Existing manual API and counts-only wire shape. */
export function runWorkflowRetentionPage(
  database: Pool,
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  retireCopy: WorkflowCopyRetirement,
  invocation?: AuthRetentionInvocation,
): Promise<WorkflowRetentionPage> {
  return createAuthWorkflowRetention(database, retireCopy, sdk, () => now.getTime()).page(retentionDays, invocation);
}

export function runWorkflowRetentionBatch(
  database: Pool,
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  retireCopy: WorkflowCopyRetirement,
  invocation?: AuthRetentionInvocation,
): Promise<number> {
  return createAuthWorkflowRetention(database, retireCopy, sdk, () => now.getTime()).batch(retentionDays, invocation);
}

export function runWorkflowRetentionSweep(
  database: Pool,
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  retireCopy: WorkflowCopyRetirement,
  invocation?: AuthRetentionInvocation,
): Promise<number> {
  return createAuthWorkflowRetention(database, retireCopy, sdk, () => now.getTime()).sweep(retentionDays, invocation);
}
