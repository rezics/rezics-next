import { DBOS, type GetWorkflowsInput, type WorkflowStatusString } from '@dbos-inc/dbos-sdk';
import { ConfigError } from '../commerce/config.ts';
import { WORK_APPLICATION } from './client.ts';
import type { WorkModule } from './registry.ts';

export const WORKFLOW_RETENTION_WORKFLOW = 'kernel.workflowRetention';
export const WORKFLOW_RETENTION_SCHEDULE = 'kernel.workflowRetention.every-10-minutes';
export const WORKFLOW_RETENTION_SCHEDULE_EXPRESSION = '*/10 * * * *';
export const DEFAULT_WORKFLOW_RETENTION_DAYS = 30;
export const MIN_WORKFLOW_RETENTION_DAYS = 7;
export const MAX_WORKFLOW_RETENTION_DAYS = 365;
export const WORKFLOW_RETENTION_BATCH_SIZE = 1000;
export const WORKFLOW_RETENTION_MAX_BATCHES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every DBOS terminal status has a completion timestamp in 5.4.6. */
export const TERMINAL_WORKFLOW_STATUSES = [
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
] as const satisfies readonly WorkflowStatusString[];

type Environment = Readonly<Record<string, string | undefined>>;
export type WorkflowRetentionConfig = Readonly<{ retentionDays: number }>;
export type WorkflowRetentionSdk = Pick<typeof DBOS, 'listWorkflows' | 'deleteWorkflows'>;

export function readWorkflowRetentionConfig(env: Environment): WorkflowRetentionConfig {
  const raw = env.KERNEL_WORKFLOW_RETENTION_DAYS;
  if (raw === undefined) return { retentionDays: DEFAULT_WORKFLOW_RETENTION_DAYS };
  if (!/^\d+$/.test(raw)) throw new ConfigError('KERNEL_WORKFLOW_RETENTION_DAYS');
  const retentionDays = Number(raw);
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new ConfigError('KERNEL_WORKFLOW_RETENTION_DAYS');
  return { retentionDays };
}

function listInput(completedBefore: string): GetWorkflowsInput {
  return {
    applicationName: WORK_APPLICATION,
    status: [...TERMINAL_WORKFLOW_STATUSES],
    completedBefore,
    limit: WORKFLOW_RETENTION_BATCH_SIZE,
    sortDesc: false,
    loadInput: false,
    loadOutput: false,
  };
}

/** Select and delete one bounded batch. The extra millisecond makes the SDK's inclusive cutoff strict. */
export async function runWorkflowRetentionBatch(
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
): Promise<number> {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new RangeError('Invalid workflow retention period');
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const statuses = await sdk.listWorkflows(listInput(new Date(cutoff - 1).toISOString()));
  const ids = statuses
    .filter(
      (status) =>
        (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status.status) &&
        typeof status.completedAt === 'number' &&
        status.completedAt < cutoff,
    )
    .slice(0, WORKFLOW_RETENTION_BATCH_SIZE)
    .map((status) => status.workflowID);
  if (ids.length > 0) await sdk.deleteWorkflows(ids, false);
  return ids.length;
}

/** One scheduled run uses one fixed cutoff and commits at most sixty SDK deletion transactions. */
export async function runWorkflowRetentionSweep(
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < WORKFLOW_RETENTION_MAX_BATCHES; batch++) {
    const removed = await runWorkflowRetentionBatch(retentionDays, sdk, now);
    deleted += removed;
    if (removed < WORKFLOW_RETENTION_BATCH_SIZE) break;
  }
  return deleted;
}

export const workflowRetentionWorkModule: WorkModule = {
  name: 'retention',
  async register({ client, env, queues }) {
    if (!Object.hasOwn(queues, 'maintenance')) throw new Error('Workflow retention requires the maintenance queue');
    const { retentionDays } = readWorkflowRetentionConfig(env);
    DBOS.registerWorkflow(async () => runWorkflowRetentionSweep(retentionDays), {
      name: WORKFLOW_RETENTION_WORKFLOW,
    });
    await client.applySchedules([
      {
        scheduleName: WORKFLOW_RETENTION_SCHEDULE,
        workflowName: WORKFLOW_RETENTION_WORKFLOW,
        schedule: WORKFLOW_RETENTION_SCHEDULE_EXPRESSION,
        queueName: 'maintenance',
        cronTimezone: 'UTC',
        automaticBackfill: false,
      },
    ]);
  },
};
