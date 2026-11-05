import { DBOS, type WorkflowStatusString } from '@dbos-inc/dbos-sdk';
import { ConfigError } from '../commerce/config.ts';
import { WORK_APPLICATION } from './client.ts';
import type { WorkModule } from './registry.ts';
import { createWorkflowRetentionSelector } from './retention-selector.ts';

export const WORKFLOW_RETENTION_WORKFLOW = 'kernel.workflowRetention';
export const WORKFLOW_RETENTION_SCHEDULE = 'kernel.workflowRetention.every-10-minutes';
export const WORKFLOW_RETENTION_SCHEDULE_EXPRESSION = '*/10 * * * *';
export const DEFAULT_WORKFLOW_RETENTION_DAYS = 30;
export const MIN_WORKFLOW_RETENTION_DAYS = 7;
export const MAX_WORKFLOW_RETENTION_DAYS = 365;
export const WORKFLOW_RETENTION_BATCH_SIZE = 1000;
export const WORKFLOW_RETENTION_MAX_BATCHES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Terminal statuses supported by the installed DBOS SDK. */
export const TERMINAL_WORKFLOW_STATUSES = [
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
] as const satisfies readonly WorkflowStatusString[];

type Environment = Readonly<Record<string, string | undefined>>;
export type WorkflowRetentionConfig = Readonly<{ retentionDays: number }>;
export type WorkflowRetentionSdk = Pick<typeof DBOS, 'deleteWorkflows'>;
/** Work-owned selector boundary; production uses the repository index via the Work pool. */
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

/** Select one batch and use supported SDK deletion without descendants. */
export async function runWorkflowRetentionBatch(
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  select?: WorkflowRetentionSelector,
  applicationName = WORK_APPLICATION,
): Promise<number> {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new RangeError('Invalid workflow retention period');
  if (!select) throw new TypeError('Workflow retention requires the indexed selector');
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const ids = [
    ...(await select({
      applicationName,
      statuses: TERMINAL_WORKFLOW_STATUSES,
      completedBefore: cutoff,
      limit: WORKFLOW_RETENTION_BATCH_SIZE,
    })),
  ].slice(0, WORKFLOW_RETENTION_BATCH_SIZE);
  if (ids.length > 0) await sdk.deleteWorkflows(ids, false);
  return ids.length;
}

/** One scheduled run uses one fixed cutoff and commits at most sixty SDK deletion transactions. */
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
  async register({ client, env, queues, pool }) {
    if (!Object.hasOwn(queues, 'maintenance')) throw new Error('Workflow retention requires the maintenance queue');
    const { retentionDays } = readWorkflowRetentionConfig(env);
    const select = createWorkflowRetentionSelector(pool);
    const applicationName = client.applicationName ?? WORK_APPLICATION;
    DBOS.registerWorkflow(
      async () => {
        // Freeze both configuration and time across worker replacement and replay.
        const start = await DBOS.runStep(async () => ({ retentionDays, now: Date.now() }), {
          name: 'kernel.workflowRetention.start',
        });
        return runWorkflowRetentionSweep(
          start.retentionDays,
          client,
          new Date(start.now),
          (batch) =>
            DBOS.runStep(batch, { name: 'kernel.workflowRetention.batch', retriesAllowed: true, maxAttempts: 3 }),
          select,
          applicationName,
        );
      },
      { name: WORKFLOW_RETENTION_WORKFLOW },
    );
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
