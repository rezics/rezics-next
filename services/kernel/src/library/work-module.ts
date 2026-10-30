import { DBOS } from '@dbos-inc/dbos-sdk';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { purgeLabelRetentionPage } from './label-retention.ts';
import { cutoverEntryIncarnationsPage } from './entry-incarnation-cutover.ts';

export const libraryWorkModule: WorkModule = {
  name: 'library',
  async register(context) {
    const { registerLibraryWork } = await import('./work.ts');
    const { registerShelfMaintenanceWork } = await import('./shelf-maintenance-runtime.ts');
    const maintenance = await registerShelfMaintenanceWork(context);
    registerLibraryWork(context, maintenance);
    const { registerFollowCountWork } = await import('./follow-count-work.ts');
    await registerFollowCountWork(context);
    const { registerLibraryEntryRetentionWork } = await import('./entry-due-work.ts');
    await registerLibraryEntryRetentionWork(context);
    const { registerLibraryMemberRetentionWork } = await import('./member-retention-work.ts');
    await registerLibraryMemberRetentionWork(context);
    await registerLabelRetention(context);
    const { registerLibraryPublishedLogRetentionWork } = await import('./published-log-retention.ts');
    await registerLibraryPublishedLogRetentionWork(context);
    const { registerCopyRetention } = await import('./copy-retention.ts');
    await registerCopyRetention(context);
    const { registerCollectionRetention } = await import('./collection-retention.ts');
    await registerCollectionRetention(context);
    await registerEntryIncarnationCutover(context);
    const { registerTypePreparationWork } = await import('./type-preparation-work.ts');
    await registerTypePreparationWork(context);
    const { registerLibraryProfileMigrationWork } = await import('./profile-migration-runtime.ts');
    registerLibraryProfileMigrationWork(context);
    const { registerMembersPreparationWork } = await import('./members-preparation-work.ts');
    await registerMembersPreparationWork(context);
    const { registerOwnerIndexWork } = await import('./owner-index-work.ts');
    await registerOwnerIndexWork(context);
    const { registerCollectionSourceWork } = await import('./collection-source-work.ts');
    await registerCollectionSourceWork(context);
  },
};

export const ENTRY_INCARNATION_CUTOVER_SWEEP_WORKFLOW = 'library.entryIncarnationCutoverSweep';
export const ENTRY_INCARNATION_CUTOVER_SCHEDULE = 'library.entryIncarnationCutover.every-10-minutes';
type IncarnationSweep = { root: string; sequence: number; partition: number; after: string | null };

async function registerEntryIncarnationCutover({ pool, client, clock }: WorkContext) {
  const page = DBOS.registerStep(
    async (partition: number, after: string | null) =>
      cutoverEntryIncarnationsPage({ pool, client, clock }, { partition, after, limit: 100 }),
    { name: 'library.entryIncarnationCutoverPage', ...COMMAND_STEP_RETRIES },
  );
  const continuation = DBOS.registerStep(
    async (input: IncarnationSweep) => {
      await client.enqueue(
        {
          workflowName: 'library.entryIncarnationCutoverSegment',
          queueName: 'maintenance',
          workflowID: `library.entryIncarnationCutover:${input.root}:${input.sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    { name: 'library.entryIncarnationCutoverContinue', ...COMMAND_STEP_RETRIES },
  );
  const segment = async (input: IncarnationSweep) => {
    let { partition, after } = input;
    // Fixed routing probes, empty pages and nonlegacy keys all pay the same segment budget.
    for (let n = 0; n < 100 && partition < 4096; n++) {
      after = (await page(partition, after)).next;
      if (after === null) partition++;
    }
    if (partition < 4096) await continuation({ ...input, partition, after, sequence: input.sequence + 1 });
    return { partition, after };
  };
  DBOS.registerWorkflow(segment, { name: 'library.entryIncarnationCutoverSegment' });
  DBOS.registerWorkflow(() => segment({ root: DBOS.workflowID!, sequence: 0, partition: 0, after: null }), {
    name: ENTRY_INCARNATION_CUTOVER_SWEEP_WORKFLOW,
  });
  await client.applySchedules([
    {
      scheduleName: ENTRY_INCARNATION_CUTOVER_SCHEDULE,
      workflowName: ENTRY_INCARNATION_CUTOVER_SWEEP_WORKFLOW,
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}

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
