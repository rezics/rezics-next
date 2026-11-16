import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readRelease } from '../semantic/definitions.ts';
import { createPublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import { subjectSource } from '../semantic/search-source.ts';
import {
  identityEpochStore,
  type IdentityChange,
  type IdentityJobRef,
  type NativeStepWork,
} from '../semantic/identity-adapters/index.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import { serializeIdentityValue as json } from '../semantic/identity-core/encoding.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { type SearchIdentityReceivingSelection } from '../semantic/identity-receiving-effects.ts';
import { createSearchIdentityReceivingNativeStore } from './identity-receiving-native-store.ts';
import type { SearchNativeReceivingPreparation } from './identity-receiving-native-internal.ts';
import { searchIdentityWriterChanged } from './identity-epoch-participant-events.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { subjectPartition } from './source.ts';
import { createSearchWriterGuard } from './writer-guard.ts';
import { readSearchIdentityOriginalPlanSql } from './identity-search-receiving-directory-sql.ts';

const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);
const digest = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');

function effectKey(consumer: string, original: string, disposition: SearchIdentityReceivingSelection['disposition']) {
  return `${consumer}:${original}:${disposition}`;
}

export async function readSearchIdentityOriginalPlan(
  pool: Pool,
  job: IdentityJobRef,
  change: IdentityChange,
  configuration: SearchReceivingConfiguration,
  deadline: number,
): Promise<SearchIdentityReceivingSelection | null> {
  const partition = subjectPartition(change.original);
  const keys = (['OLD', 'NEW', 'first-apply', 'handoff'] as const).map((disposition) =>
    effectKey(configuration.consumer, change.original, disposition),
  );
  const plans = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query<{ effect_key: string; source: SearchNativeReceivingPreparation['source']; proven: boolean }>(
          readSearchIdentityOriginalPlanSql,
          [partition, job.jobId, String(job.epoch), keys, change.original, configuration.index],
        )
      ).rows,
    deadline,
  );
  const plan = plans[0];
  if (!plan) return null;
  const { source } = plan;
  if (
    plans.length !== 1 ||
    !plan.proven ||
    source.receivingHome !== partition ||
    source.locator.partition !== partition ||
    source.original !== change.original ||
    source.terminal !== change.terminal ||
    source.consumer !== configuration.consumer ||
    source.physicalTarget !== configuration.index ||
    plan.effect_key !== effectKey(source.consumer, source.original, source.disposition)
  )
    throw unavailable('Retained Search plan changed for the selected original');
  return {
    job,
    original: source.original,
    effectKey: plan.effect_key,
    owner: source.owner,
    sourceId: source.sourceId,
    scope: source.scope,
    disposition: source.disposition,
    native: source.locator,
  };
}

function receivingDisposition(
  change: IdentityChange,
  retained: readonly { original: string }[],
): SearchIdentityReceivingSelection['disposition'] {
  if (change.original !== change.terminal) return 'OLD';
  return retained.length > 0 ? 'NEW' : 'first-apply';
}

/** Resolve the admitted public-filter definition once per home. A release digest is not a definition id. */
async function publishedSourceDefinition(
  pool: Pool,
  configuration: SearchReceivingConfiguration,
  releaseDigest: string,
  deadline: number,
) {
  const release = await readRelease(pool, releaseDigest);
  if (!release) throw unavailable('Search receiving plans require the admitted Source release');
  const resolved = await createPublicFilterSourceBinding(pool, configuration.routeKey, configuration.access).resolve(
    {
      source: publicFilterSource(configuration),
      meaning: { digest: releaseDigest, release },
      capture: { sort: 'id', size: 20, filterDocument: undefined, text: undefined },
    },
    { deadline },
  );
  if (resolved.status !== 'resolved') throw unavailable('Search receiving plans require a published Source definition');
  return resolved.definition;
}

/** Prepare the exact next original selected from the retained control directory. */
export async function commitSearchIdentityReceivingPlan(
  pool: Pool,
  job: IdentityJobRef,
  change: IdentityChange,
  scopeDigest: string,
  releaseDigest: string,
  configuration: SearchReceivingConfiguration,
  context: Readonly<{ deadline: number; allowance: NativeStepWork }>,
): Promise<SearchIdentityReceivingSelection> {
  const partition = subjectPartition(change.original);
  const guard = createSearchWriterGuard({
    pool,
    search: configuration.search,
    index: configuration.index,
    consumer: configuration.consumer,
    source: subjectSource(pool, configuration.routeKey),
    listing: subjectListingSource(pool),
  });
  try {
    await guard.write(partition, [change.original], 0n);
  } catch (error) {
    if (!(error instanceof IdentityEpochStoreError) || !error.message.includes('closed to writer enrollment'))
      throw error;
  }
  const fence = await guard.fenceOriginal(job, change.original);
  const barrier = await guard.closeGeneration(partition);
  const store = createSearchIdentityReceivingNativeStore({
    pool,
    index: configuration.index,
    consumer: configuration.consumer,
  });
  const definition = await publishedSourceDefinition(pool, configuration, releaseDigest, context.deadline);
  const mapping = await identityEpochStore().readMapping(pool, change.original);
  if (mapping.state !== 'mapped')
    throw unavailable('Search receiving original has no published mapping; absence is not a self binding');
  if (mapping.terminal !== change.terminal)
    throw unavailable('Search receiving mapping disagrees with the change page');
  const copy = await guard.readRetainedCopy(barrier.locator, change.original, context.deadline);
  const retained = copy ? [copy] : [];
  const disposition = receivingDisposition(change, retained);
  const documentId = disposition === 'OLD' ? change.original : change.terminal;
  const ownerRoute = routeOf(documentId);
  if (ownerRoute === null || partitionOf(ownerRoute) !== partition)
    throw unavailable('Search receiving document is outside the enrolled home');
  const locator = {
    kind: 'search-canonical-index' as const,
    version: 1 as const,
    partition,
    planId: randomUUID(),
  };
  const scope = effectKey(configuration.consumer, change.original, disposition);
  const selection: SearchIdentityReceivingSelection = {
    job,
    original: change.original,
    effectKey: scope,
    owner: documentId,
    sourceId: documentId,
    scope,
    disposition,
    native: locator,
  };
  const input: SearchNativeReceivingPreparation = {
    selection,
    source: {
      locator,
      original: change.original,
      terminal: change.terminal,
      documentId,
      owner: documentId,
      sourceId: documentId,
      scope,
      disposition,
      receivingHome: partition,
      receivingEpoch: barrier.native.epoch,
      consumer: configuration.consumer,
      physicalTarget: configuration.index,
      incarnation: barrier.incarnation,
      writeAlias: barrier.writeAlias,
      physicalGeneration: barrier.physicalGeneration,
      enrollmentGeneration: barrier.enrollmentGeneration,
      fenceGeneration: barrier.fenceGeneration,
      barrier: barrier.locator,
      originalFence: fence.gate,
    },
    scopeDigest,
    references: {
      originalSupport: null,
      terminalSupport: null,
      definition: definition.readDefinition,
      release: definition.meaning.digest,
      documentFence: fence.gate,
      predecessor: null,
    },
    actionDigest: digest({ original: change.original, disposition, job, index: configuration.index }),
    copies: retained.map((copy) => ({
      home: partition,
      consumer: configuration.consumer,
      physicalTarget: configuration.index,
      incarnation: barrier.incarnation,
      writeAlias: barrier.writeAlias,
      original: copy.original,
      close: fence.gate,
      enrollment: copy.enrollment,
      visible: copy.visible,
      state: copy.state,
    })),
  };
  const saved = await runCommand(
    pool,
    { partition, deadline: context.deadline, clock: configuration.clock },
    async (tx) => {
      const prepared = await store.preparePlan(tx, input, context);
      const selected = prepared.value.selection;
      if (selected.native.planId !== locator.planId) return noEffect(selected);
      return { value: selected, events: searchIdentityWriterChanged() };
    },
  );
  return saved.value;
}
