import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { subjectSource } from '../semantic/search-source.ts';
import {
  identityEpochStore,
  identityJobPartition,
  IdentityEpochStoreError,
  serializeIdentityValue as json,
  type IdentityChange,
  type IdentityJobRef,
  type NativeStepWork,
} from '../semantic/identity-adapters/index.ts';
import { withReadTransaction } from '../semantic/read.ts';
import {
  prepareSearchIdentityReceivingEffect,
  type SearchIdentityReceivingSelection,
} from '../semantic/identity-receiving-effects.ts';
import { createSearchIdentityReceivingNativeStore } from './identity-receiving-native-store.ts';
import type { SearchNativeReceivingPreparation } from './identity-receiving-native-internal.ts';
import { searchIdentityWriterChanged } from './identity-epoch-participant-events.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { subjectPartition } from './source.ts';
import { createSearchWriterGuard, SEARCH_IDENTITY_WRITER_CHUNK } from './writer-guard.ts';
import existingPlansSql from './identity-search-receiving-existing-plans.sql';
import jobScopeSql from './identity-epoch-participant-job-scope.sql';
import enrollSql from './identity-search-receiving-enroll.sql';

const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);
const digest = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');

function planned(original: string, existing: ReadonlySet<string>) {
  return existing.has(original);
}

/** Source-owned Search native plans and common receiving enrollment for one bounded home page.
 * Writer close happens after every original in that home is enrolled, never between them.
 */
export async function commitSearchIdentityReceivingPlans(
  pool: Pool,
  job: IdentityJobRef,
  configuration: SearchReceivingConfiguration,
  context: Readonly<{ deadline: number; allowance: NativeStepWork }>,
): Promise<'prepared' | 'exhausted'> {
  const home = identityJobPartition(job);
  const saved = await withReadTransaction(pool, (tx) => identityEpochStore().readJob(tx, job), context.deadline);
  if (!saved || saved.mapping?.state !== 'complete')
    throw unavailable('Search receiving plans require authoritative mapping custody');
  const existing = await withReadTransaction(
    pool,
    async (tx) =>
      new Set(
        (
          await tx.query<{ original: string }>(existingPlansSql.sql, [job.jobId, job.epoch.toString()])
        ).rows.map((row) => row.original),
      ),
    context.deadline,
  );
  const changes: IdentityChange[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await withReadTransaction(
      pool,
      (tx) => identityEpochStore().pageChanges(tx, job, after),
      context.deadline,
    );
    changes.push(...page.changes);
    if (!page.next) break;
    after = page.next;
  }
  const pending = changes.filter((change) => !planned(change.original, existing));
  if (!pending.length) return 'exhausted';
  const partition = subjectPartition(pending[0]!.original);
  const cohort = pending.filter((change) => subjectPartition(change.original) === partition);
  const guard = createSearchWriterGuard({
    pool,
    search: configuration.search,
    index: configuration.index,
    consumer: configuration.consumer,
    source: subjectSource(pool, configuration.routeKey),
    listing: subjectListingSource(pool),
  });
  const ids = [...new Set(cohort.map((change) => change.original))];
  try {
    for (let offset = 0; offset < ids.length; offset += SEARCH_IDENTITY_WRITER_CHUNK) {
      await guard.write(partition, ids.slice(offset, offset + SEARCH_IDENTITY_WRITER_CHUNK), 0n);
    }
  } catch (error) {
    if (!(error instanceof IdentityEpochStoreError) || !error.message.includes('closed to writer enrollment'))
      throw error;
  }
  const fences = new Map<string, Awaited<ReturnType<typeof guard.fenceOriginal>>>();
  for (const original of ids) fences.set(original, await guard.fenceOriginal(job, original));
  const barrier = await guard.closeGeneration(partition);
  const copies: Awaited<ReturnType<typeof guard.readRetainedCopies>>['copies'][number][] = [];
  for (let cursor: string | null = null; ; ) {
    const page = await guard.readRetainedCopies(barrier.locator, cursor);
    copies.push(...page.copies);
    if (!page.next) break;
    cursor = page.next;
  }
  const store = createSearchIdentityReceivingNativeStore({
    pool,
    index: configuration.index,
    consumer: configuration.consumer,
  });
  const scopeDigest = (
    await withReadTransaction(
      pool,
      async (tx) =>
        (await tx.query<{ scope_digest: string }>(jobScopeSql.sql, [home, job.jobId, job.epoch.toString()])).rows[0]
          ?.scope_digest,
      context.deadline,
    )
  );
  if (!scopeDigest) throw unavailable('Search receiving plans lost the admitted job scope');
  for (const change of cohort) {
    const fence = fences.get(change.original);
    if (!fence) throw unavailable('Search receiving original fence is missing');
    const disposition = change.original === change.terminal ? 'NEW' : 'OLD';
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
    const scope = `${configuration.consumer}:${change.original}:${disposition}`;
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
    const retained = copies.filter((copy) => copy.original === change.original);
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
        definition: saved.intent.release,
        release: saved.intent.release,
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
    await runCommand(pool, { partition, deadline: context.deadline, clock: configuration.clock }, async (tx) => {
      const prepared = await store.preparePlan(tx, input, context);
      if (prepared.value.selection.native.planId !== locator.planId)
        return noEffect(prepared.value.selection.native.planId);
      return { value: locator.planId, events: searchIdentityWriterChanged() };
    });
  }
  return 'prepared';
}

/** Common receiving enrollment for a native plan already committed by Source. */
export async function enrollSearchIdentityReceivingPlans(
  pool: Pool,
  job: IdentityJobRef,
): Promise<'enrolled' | 'ready'> {
  const home = identityJobPartition(job);
  const row = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query<{
          plan_id: string;
          original_id: string;
          document_id: string;
          effect_key: string;
          source: {
            scope: string;
            disposition: SearchIdentityReceivingSelection['disposition'];
            locator: SearchIdentityReceivingSelection['native'];
            owner: string;
            sourceId: string;
          };
        }>(enrollSql.sql, [job.jobId, job.epoch.toString(), home])
      ).rows[0],
  );
  if (!row) return 'ready';
  const source = row.source;
  await prepareSearchIdentityReceivingEffect(pool, {
    job,
    original: row.original_id,
    owner: source.owner,
    sourceId: source.sourceId,
    effectKey: row.effect_key,
    scope: source.scope,
    disposition: source.disposition,
    native: source.locator,
  });
  return 'enrolled';
}
