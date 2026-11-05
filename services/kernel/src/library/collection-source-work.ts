import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomUUID } from 'node:crypto';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  withIdentitySourceConsumerMaintenance,
} from '../semantic/identity-source-consumer-maintenance.ts';
import {
  bindCanonicalSourceWork,
  advanceCanonicalSourceCapture,
  readCanonicalSourceState,
  beginCanonicalSourceRepair,
  repairCanonicalSourceStep,
  publishCanonicalSourceRepair,
  CANONICAL_SOURCE_WORKFLOW,
  type CanonicalAllowance,
} from './canonical-source-store.ts';
import { CANONICAL_SOURCE_REPAIR_STEP, canonicalSourceCallAllowance } from './canonical-source-bounds.ts';

const sourceStepAllowance = (): CanonicalAllowance => ({
  reservationId: randomUUID(),
  ...canonicalSourceCallAllowance(CANONICAL_SOURCE_REPAIR_STEP),
});
type SourceLocator = { accounts: [string]; collectionId: string };
type SourceSweep = {
  root: string;
  sequence: number;
  partition: number;
  route: number | null;
  collection: string | null;
};
export async function advanceCollectionSourceWork(
  context: WorkContext,
  input: SourceLocator,
): Promise<'ready' | 'more' | 'unavailable'> {
  const active = activeIdentitySourceConsumerMaintenance(context.pool);
  const deadline = Math.min(Date.now() + 30000, active?.deadline ?? Infinity);
  const run = () => advanceSourceStep(context, input, deadline);
  return active
    ? run()
    : withIdentitySourceConsumerMaintenance({ pool: context.pool, env: context.env }, { deadline }, run);
}
async function advanceSourceStep(
  context: WorkContext,
  input: SourceLocator,
  deadline: number,
): Promise<'ready' | 'more' | 'unavailable'> {
  const route = routeOf(input.collectionId);
  if (
    route === null ||
    input.accounts.length !== 1 ||
    routeOf(input.accounts[0]) === null ||
    partitionOf(routeOf(input.accounts[0])!) !== partitionOf(route) ||
    Buffer.byteLength(JSON.stringify(input)) > 4096
  )
    throw new TypeError('Invalid native Source work locator');
  const call = {
    route,
    collectionId: input.collectionId,
    deadline,
    allowance: sourceStepAllowance(),
  };
  const observed = await advanceCanonicalSourceCapture(context.pool, call);
  if (observed.state !== 'admitted') {
    return observed.reason === 'incomplete' ? 'more' : 'unavailable';
  }
  const ready = await readCanonicalSourceState(context.pool, call);
  if (ready.state === 'ready') return 'ready';
  const started = await beginCanonicalSourceRepair(context.pool, { ...call, basis: observed.basis });
  if (started.state !== 'working') return 'unavailable';
  const next = await repairCanonicalSourceStep(context.pool, {
    ...call,
    basis: observed.basis,
    repair: started.repair,
  });
  if (next.state !== 'complete') return next.state === 'working' ? 'more' : 'unavailable';
  const published = await publishCanonicalSourceRepair(context.pool, {
    ...call,
    basis: observed.basis,
    repair: next.repair,
  });
  return published.state === 'published' ? 'ready' : 'unavailable';
}
/** The existing Library worker owns native checkpoints. No Source GET writes, scheduler or new participant. */
export async function registerCollectionSourceWork(context: WorkContext): Promise<void> {
  bindCanonicalSourceWork(context);
  const page = (input: SourceLocator) => advanceCollectionSourceWork(context, input);
  const step = DBOS.registerStep(page, { name: 'library.canonicalSourcePage', ...COMMAND_STEP_RETRIES });
  DBOS.registerWorkflow((input: SourceLocator) => step(input), { name: CANONICAL_SOURCE_WORKFLOW });
  const sweepPage = DBOS.registerStep(
    async (input: SourceSweep): Promise<SourceSweep> => {
      const { rows } = await withConnection(context.pool, (client) =>
        client.query<{ route: number; collection: string; owner: string | null }>(
          `SELECT route,collection_id::text AS collection,curator_account_id::text AS owner FROM library.collection
       WHERE route BETWEEN $1 AND $2 AND ($3::integer IS NULL OR (route,collection_id)>($3,$4::uuid))
       ORDER BY route,collection_id LIMIT 1`,
          [input.partition * 16, input.partition * 16 + 15, input.route, input.collection],
        ),
      );
      const row = rows[0];
      if (!row) return { ...input, partition: input.partition + 1, route: null, collection: null };
      if (row.owner) await page({ accounts: [row.owner], collectionId: row.collection });
      return { ...input, route: row.route, collection: row.collection };
    },
    { name: 'library.canonicalSourceSweepPage', ...COMMAND_STEP_RETRIES },
  );
  const continuation = DBOS.registerStep(
    async (input: SourceSweep) => {
      await context.client.enqueue(
        {
          workflowName: 'library.canonicalSourceSweepSegment',
          queueName: 'maintenance',
          workflowID: `library.canonicalSourceSweep:${input.root}:${input.sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    { name: 'library.canonicalSourceSweepContinue', ...COMMAND_STEP_RETRIES },
  );
  async function segment(input: SourceSweep) {
    let next = input;
    for (let n = 0; n < 100 && next.partition < 4096; n++) next = await sweepPage(next);
    if (next.partition < 4096) await continuation({ ...next, sequence: next.sequence + 1 });
  }
  DBOS.registerWorkflow(segment, { name: 'library.canonicalSourceSweepSegment' });
  DBOS.registerWorkflow(
    () => segment({ root: DBOS.workflowID!, sequence: 0, partition: 0, route: null, collection: null }),
    { name: 'library.canonicalSourceSweep' },
  );
  await context.client.applySchedules([
    {
      scheduleName: 'library.canonicalSource.every-10-minutes',
      workflowName: 'library.canonicalSourceSweep',
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}

// Library-owned declaration region. Components never grant or refill work. A whole
// installed declaration covers only the enforced selected Library schedule.
export {
  IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION,
  declareLibraryIdentityStatement,
  assembleLibraryIdentityOriginalComponents,
  LIBRARY_IDENTITY_CHECKOUT_WORK,
  LIBRARY_IDENTITY_ORIGINAL_MISSING_OPERANDS,
  assembleLibraryIdentitySelectedBodies,
  LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES,
  LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS,
} from './identity-original-work.ts';
