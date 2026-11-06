import { DBOS, type WorkflowStatusString } from '@dbos-inc/dbos-sdk';
import { ConfigError } from '../commerce/config.ts';
import { WORK_APPLICATION } from './client.ts';
import type { WorkModule } from './registry.ts';
import {
  DEFAULT_WORKFLOW_RETENTION_DAYS,
  MAX_WORKFLOW_RETENTION_DAYS,
  MIN_WORKFLOW_RETENTION_DAYS,
  TERMINAL_WORKFLOW_STATUSES as TERMINAL,
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_MAX_BATCHES,
  WORKFLOW_RETENTION_SCHEDULE,
  WORKFLOW_RETENTION_SCHEDULE_EXPRESSION,
  WORKFLOW_RETENTION_WORKFLOW,
} from './contract/index.ts';
import {
  assertRetentionDays,
  clampRetentionBatch,
  parseWorkflowRetentionDays,
  retentionCutoff,
} from './core/index.ts';
import { ensureNativeWorkApplication } from './adapters/index.ts';

export {
  WORKFLOW_RETENTION_WORKFLOW,
  WORKFLOW_RETENTION_SCHEDULE,
  WORKFLOW_RETENTION_SCHEDULE_EXPRESSION,
  DEFAULT_WORKFLOW_RETENTION_DAYS,
  MIN_WORKFLOW_RETENTION_DAYS,
  MAX_WORKFLOW_RETENTION_DAYS,
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_MAX_BATCHES,
};

export const TERMINAL_WORKFLOW_STATUSES = TERMINAL satisfies readonly WorkflowStatusString[];

type Environment = Readonly<Record<string, string | undefined>>;
export type WorkflowRetentionConfig = Readonly<{ retentionDays: number }>;
export type WorkflowRetentionSdk = Pick<typeof DBOS, 'deleteWorkflows'>;
export type WorkflowRetentionSelector = (
  input: Readonly<{
    applicationName: string;
    statuses: typeof TERMINAL_WORKFLOW_STATUSES;
    completedBefore: number;
    limit: number;
  }>,
) => Promise<readonly string[]>;
type RetentionBatchStep = (batch: () => Promise<number>) => Promise<number>;

export function readWorkflowRetentionConfig(env: Environment): WorkflowRetentionConfig {
  try {
    return { retentionDays: parseWorkflowRetentionDays(env.KERNEL_WORKFLOW_RETENTION_DAYS) };
  } catch (error) {
    if (error instanceof RangeError) throw new ConfigError('KERNEL_WORKFLOW_RETENTION_DAYS');
    throw error;
  }
}

export async function runWorkflowRetentionBatch(
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  select?: WorkflowRetentionSelector,
  applicationName = WORK_APPLICATION,
): Promise<number> {
  assertRetentionDays(retentionDays);
  if (!select) throw new TypeError('Workflow retention requires the indexed selector');
  const ids = clampRetentionBatch(
    await select({
      applicationName,
      statuses: TERMINAL_WORKFLOW_STATUSES,
      completedBefore: retentionCutoff(now, retentionDays),
      limit: WORKFLOW_RETENTION_BATCH_SIZE,
    }),
  );
  if (ids.length > 0) await sdk.deleteWorkflows([...ids], false);
  return ids.length;
}

export async function runWorkflowRetentionSweep(
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  step: RetentionBatchStep = (batch) => batch(),
  select?: WorkflowRetentionSelector,
  applicationName = WORK_APPLICATION,
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < WORKFLOW_RETENTION_MAX_BATCHES; batch++) {
    const removed = await step(() => runWorkflowRetentionBatch(retentionDays, sdk, now, select, applicationName));
    deleted += removed;
    if (removed < WORKFLOW_RETENTION_BATCH_SIZE) break;
  }
  return deleted;
}

export const workflowRetentionWorkModule: WorkModule = {
  name: 'retention',
  async register(context) {
    try {
      await ensureNativeWorkApplication().registerRetention(context);
    } catch (error) {
      if (error instanceof RangeError) throw new ConfigError('KERNEL_WORKFLOW_RETENTION_DAYS');
      throw error;
    }
  },
};
