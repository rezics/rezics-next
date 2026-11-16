/** Canonical Source sweep/repair. NativeCollectionWork lives on the leaf public entry. */
export {
  CollectionSourceLedger,
  NativeCollectionWork,
  bindNativeCollectionWorkLifetime,
  instrumentNativeCollectionWork,
  requireNativeCollectionFootprint,
  withNativeCollectionWorkAllowance,
} from './collection-native-work.ts';
export type { WorkAllowance, WorkDimensions, WorkReceipt } from './contract/work-dimensions.ts';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomUUID } from 'node:crypto';
import { withConnection } from '../database/pool.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
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
import { librarySemanticObservations } from './semantic-observation.ts';
import { COLLECTION_PUBLICATION_WORKFLOW } from './contract/index.ts';
import publicationRecoverySQL from './collection-publication-recovery.sql';
import publicationSupersededSQL from './collection-publication-superseded.sql';
import { collectionPublicationOutputProducer } from './collection-publication-output.ts';
import { reclaimSupersededCollectionOutput } from './collection-publication-reclaim.ts';
import { reinspectFrozenCollection } from './collection-retention.ts';
import frozenCaptureSQL from './collection-publication-frozen-capture.sql';
import { publicOutputFreezeWork, publicOutputFrozenCaptureWork, publicOutputRetireWork } from '../semantic/identity-public-output-work.ts';
import { withCollectionReadConnection } from './collection-read-connection.ts';
import { workStepDeadline } from './collection-command-work.ts';

const sourceStepAllowance = (observations = librarySemanticObservations()): CanonicalAllowance => ({
  reservationId: randomUUID(),
  ...canonicalSourceCallAllowance(CANONICAL_SOURCE_REPAIR_STEP(observations)),
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
  const semanticObservations = librarySemanticObservations();
  const call = {
    route,
    collectionId: input.collectionId,
    deadline,
    semanticObservations,
    allowance: sourceStepAllowance(semanticObservations),
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
async function retainFrozenPublication(
  context: WorkContext,
  row: { route: number; collection: string },
): Promise<boolean> {
  const deadline = workStepDeadline();
  const capture = await withCollectionReadConnection(
    context.pool,
    deadline,
    async (tx) =>
      (
        await tx.query<{
          generation: string;
          transactionId: string;
          position: string;
          sourceGeneration: string;
          releaseDigest: string | null;
          sealedBindingDigest: string | null;
          cleanupAccountId: string | null;
        }>(frozenCaptureSQL.sql, [row.route, row.collection])
      ).rows[0],
  );
  if (!capture) return false;
  if (capture.cleanupAccountId) {
    const page = await reinspectFrozenCollection(
      context.pool,
      { accountId: capture.cleanupAccountId, collectionId: row.collection, retainedGeneration: capture.generation },
      deadline,
    );
    return page.status === 'progress' || page.status === 'purged';
  }
  const producer = collectionPublicationOutputProducer(context);
  if (capture.sealedBindingDigest) {
    const result = await producer.retainFrozen(
      {
        kind: 'public-output',
        partition: partitionOf(row.route),
        captureId: capture.generation,
        bindingDigest: capture.sealedBindingDigest,
      },
      { deadline, allowance: { reservationId: capture.generation, remaining: publicOutputFreezeWork() } },
    );
    return result.status === 'applied';
  }
  const { generation, transactionId, position, sourceGeneration } = capture;
  const result = await producer.advanceFrozenPublication(
    {
      route: row.route,
      collectionId: row.collection,
      generation,
      activation: { transactionId, position, sourceGeneration },
    },
    capture.releaseDigest,
    { deadline, allowance: { reservationId: generation, remaining: publicOutputFrozenCaptureWork() } },
  );
  return result.status === 'more' || result.status === 'sealed';
}

async function retireSupersededPublication(context: WorkContext, row: { route: number; collection: string }) {
  const deadline = workStepDeadline();
  const retired = await withCollectionReadConnection(context.pool, deadline, async (tx) =>
    (
      await tx.query<{ captureId: string; bindingDigest: string; disposed: boolean }>(publicationSupersededSQL.sql, [
        row.route,
        row.collection,
      ])
    ).rows[0],
  );
  if (!retired) return;
  const { captureId, bindingDigest } = retired;
  if (retired.disposed) {
    await reclaimSupersededCollectionOutput(
      context.pool,
      { route: row.route, collectionId: row.collection, generation: captureId },
      deadline,
    );
    return;
  }
  // Both cancellation and reclamation resume in bounded pages from the existing sweep.
  await collectionPublicationOutputProducer(context).retireSuperseded(
    { kind: 'public-output', partition: partitionOf(row.route), captureId, bindingDigest },
    { deadline, allowance: { reservationId: captureId, remaining: publicOutputRetireWork() } },
  );
}

async function recoverCollectionPublication(
  context: WorkContext,
  input: { route: number; collection: string; owner: string },
  sweep: string,
): Promise<void> {
  const { route, collection, owner } = input;
  const publication = await withCollectionReadConnection(context.pool, workStepDeadline(), async (tx) =>
    (await tx.query<{ publicationId: string }>(publicationRecoverySQL.sql, [route, collection, owner])).rows[0],
  );
  if (!publication) return;
  await context.client.enqueue(
    {
      queueName: 'workflows',
      workflowName: COLLECTION_PUBLICATION_WORKFLOW,
      workflowID: `${publication.publicationId}:recovery:${sweep}:output:0`,
      workflowIDReusePolicy: 'return-existing',
    },
    { route, publicationId: publication.publicationId, collectionId: collection, ownerAccountId: owner, accounts: [owner] },
    0,
  );
}

/** The existing Library worker owns native checkpoints. No Source GET writes, scheduler or new participant. */
export async function registerCollectionSourceWork(context: WorkContext): Promise<void> {
  bindCanonicalSourceWork(context);
  const page = (input: SourceLocator) => advanceCollectionSourceWork(context, input);
  const step = DBOS.registerStep(page, { name: 'library.canonicalSourcePage', ...COMMAND_STEP_RETRIES });
  DBOS.registerWorkflow((input: SourceLocator) => step(input), { name: CANONICAL_SOURCE_WORKFLOW });
  const sweepPage = DBOS.registerStep(
    async (input: SourceSweep): Promise<SourceSweep> => {
      // Without a row cursor, seek past the greatest key of the preceding route.
      const afterRoute = input.route ?? input.partition * 16 - 1;
      const { rows } = await withConnection(context.pool, (client) =>
        client.query<{ route: number; collection: string; owner: string | null; builtin: string | null }>(
          `SELECT c.route,c.collection_id::text AS collection,a.account_id::text AS owner,c.builtin_kind AS builtin
       FROM (
         SELECT route,collection_id,curator_account_id,builtin_kind
         FROM library.collection
         WHERE (route,collection_id)>($1,COALESCE($2::uuid,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
         ORDER BY route,collection_id LIMIT 1
       ) c
       LEFT JOIN access.account a ON (a.route,a.account_id)=(c.route,c.curator_account_id)
         AND a.state='active' AND NOT a.authn_fenced`,
          [afterRoute, input.collection],
        ),
      );
      const row = rows[0];
      if (!row) return { ...input, partition: PARTITIONS, route: null, collection: null };
      if (row.builtin === 'everything' || row.builtin === 'state') {
        if (row.owner) await recoverCollectionPublication(context, { ...row, owner: row.owner }, input.root);
        // Revisit after capture, transfer or terminal cleanup progresses.
        if (await retainFrozenPublication(context, row)) return input;
        await retireSupersededPublication(context, row);
      }
      if (row.owner) await page({ accounts: [row.owner], collectionId: row.collection });
      return { ...input, partition: partitionOf(row.route), route: row.route, collection: row.collection };
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
    for (let n = 0; n < 100 && next.partition < PARTITIONS; n++) next = await sweepPage(next);
    if (next.partition < PARTITIONS) await continuation({ ...next, sequence: next.sequence + 1 });
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
