import {
  TERMINAL_WORKFLOW_STATUSES,
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_MAX_BATCHES,
  WORKFLOW_RETENTION_SCHEDULE,
  WORKFLOW_RETENTION_SCHEDULE_EXPRESSION,
  WORKFLOW_RETENTION_WORKFLOW,
} from '../contract/bounds.ts';
import { WORK_APPLICATION } from '../contract/vocabulary.ts';
import type { WorkApplicationPorts, WorkPool, WorkQueueOptions, WorkSdkClient } from '../contract/index.ts';
import {
  assertRetentionDays,
  clampRetentionBatch,
  readWorkflowRetentionConfig,
  retentionCutoff,
} from '../core/index.ts';

type Selector = (
  input: Readonly<{
    applicationName: string;
    statuses: readonly ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
    completedBefore: number;
    limit: number;
  }>,
) => Promise<readonly string[]>;

type Deleter = (ids: readonly string[], descendants: false) => Promise<void>;

export function createRetention(ports: Pick<WorkApplicationPorts, 'sdkRuntime' | 'retentionSelector' | 'now'>) {
  async function runRetentionBatch(
    retentionDays: number,
    now: Date,
    select: Selector,
    applicationName: string,
    deleter: Deleter = (ids, descendants) => ports.sdkRuntime.deleteWorkflows(ids, descendants),
  ): Promise<number> {
    assertRetentionDays(retentionDays);
    const ids = clampRetentionBatch(
      await select({
        applicationName,
        statuses: TERMINAL_WORKFLOW_STATUSES,
        completedBefore: retentionCutoff(now, retentionDays),
        limit: WORKFLOW_RETENTION_BATCH_SIZE,
      }),
    );
    if (ids.length > 0) await deleter(ids, false);
    return ids.length;
  }

  async function runRetentionSweep(
    retentionDays: number,
    now: Date,
    step: (batch: () => Promise<number>) => Promise<number>,
    select: Selector,
    applicationName: string,
    deleter?: Deleter,
  ): Promise<number> {
    let deleted = 0;
    for (let batch = 0; batch < WORKFLOW_RETENTION_MAX_BATCHES; batch++) {
      const removed = await step(() => runRetentionBatch(retentionDays, now, select, applicationName, deleter));
      deleted += removed;
      if (removed < WORKFLOW_RETENTION_BATCH_SIZE) break;
    }
    return deleted;
  }

  return {
    runRetentionBatch,
    runRetentionSweep,
    async registerRetention(context: {
      client: WorkSdkClient;
      env: Readonly<Record<string, string | undefined>>;
      queues: Readonly<Record<string, WorkQueueOptions>>;
      pool: WorkPool;
    }): Promise<void> {
      if (!Object.hasOwn(context.queues, 'maintenance'))
        throw new Error('Workflow retention requires the maintenance queue');
      const { retentionDays } = readWorkflowRetentionConfig(context.env);
      const select = ports.retentionSelector.create(context.pool);
      const applicationName = (context.client as { applicationName?: string }).applicationName ?? WORK_APPLICATION;
      const deleter: Deleter = (ids, descendants) =>
        (context.client as { deleteWorkflows: Deleter }).deleteWorkflows(ids, descendants);
      ports.sdkRuntime.registerWorkflow(
        async () => {
          const start = await ports.sdkRuntime.runStep(async () => ({ retentionDays, now: ports.now() }), {
            name: 'kernel.workflowRetention.start',
          });
          return runRetentionSweep(
            start.retentionDays,
            new Date(start.now),
            (batch) =>
              ports.sdkRuntime.runStep(batch, {
                name: 'kernel.workflowRetention.batch',
                retriesAllowed: true,
                maxAttempts: 3,
              }),
            select,
            applicationName,
            deleter,
          );
        },
        { name: WORKFLOW_RETENTION_WORKFLOW },
      );
      await ports.sdkRuntime.applySchedules(context.client, [
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
}
