import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { purgeLabelRetentionPage } from './label-retention.ts';

export const libraryWorkModule: WorkModule = {
  name: 'library',
  async register(context) {
    const { registerLibraryWork } = await import('./work.ts');
    registerLibraryWork(context);
    const { registerLibraryEntryRetentionWork } = await import('./entry-due-work.ts');
    await registerLibraryEntryRetentionWork(context);
    await registerLabelRetention(context);
    const { registerLibraryPublishedLogRetentionWork } = await import('./published-log-retention.ts');
    await registerLibraryPublishedLogRetentionWork(context);
  },
};

export const LABEL_RETENTION_SWEEP_WORKFLOW = 'library.labelRetentionSweep';
export const LABEL_RETENTION_SCHEDULE = 'library.labelRetention.every-10-minutes';
type LabelSweep = { root: string; sequence: number; partition: number; after: string | null };

async function registerLabelRetention({ pool, client, clock }: WorkContext) {
  const page = DBOS.registerStep(
    async (partition: number, after: string | null) =>
      purgeLabelRetentionPage({ pool, clock }, { partition, limit: 100, after }),
    { name: 'library.labelRetentionPage', ...COMMAND_STEP_RETRIES },
  );
  const continuation = DBOS.registerStep(
    async (input: LabelSweep) => {
      await client.enqueue(
        {
          workflowName: 'library.labelRetentionSegment',
          queueName: 'maintenance',
          workflowID: `library.labelRetention:${input.root}:${input.sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    { name: 'library.labelRetentionContinue', ...COMMAND_STEP_RETRIES },
  );
  const segment = async (input: LabelSweep) => {
    let { partition, after } = input;
    for (let n = 0; n < 100 && partition < 4096; n++) {
      after = (await page(partition, after)).next;
      if (after === null) partition++;
    }
    if (partition < 4096) await continuation({ ...input, sequence: input.sequence + 1, partition, after });
    return { partition, after };
  };
  DBOS.registerWorkflow(segment, { name: 'library.labelRetentionSegment' });
  DBOS.registerWorkflow(async () => segment({ root: DBOS.workflowID!, sequence: 0, partition: 0, after: null }), {
    name: LABEL_RETENTION_SWEEP_WORKFLOW,
  });
  await client.applySchedules([
    {
      scheduleName: LABEL_RETENTION_SCHEDULE,
      workflowName: LABEL_RETENTION_SWEEP_WORKFLOW,
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}
