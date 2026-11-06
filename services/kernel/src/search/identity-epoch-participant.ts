import { ConfigError } from '../commerce/config.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { currentCommand, noEffect, registerCommandCallback, runCommand } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { deadlineFor } from '../request/deadline.ts';
import type { Access } from '../request/access.ts';
import type {
  IdentityEpochStep,
  IdentityStepProgress,
  NativeStepWork,
  IdentityFrontier,
  IdentityNativeReceipt,
} from '../semantic/identity-epoch-contract.ts';
import {
  identityEpochStore,
  identityJobPartition,
  IdentityEpochStoreError,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
} from '../semantic/identity-adapters/index.ts';
import { bindSemanticProducerRoles, identityErasureRoles } from '../semantic/erasure-producer.ts';
import {
  installSearchIdentityReceivingNative,
  lookupIdentityReceivingEffect,
  prepareSearchIdentityReceivingEffect,
  recordIdentityReceivingEffect,
  reconcileIdentityReceivingEffect,
  type SearchReceivingWorkDeclaration,
} from '../semantic/identity-receiving-effects.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  currentIdentitySourceConsumerMaintenance,
  identitySourceConsumerLibraryWork,
  identitySourceConsumerNativeWork,
} from '../semantic/identity-source-consumer-maintenance.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
import { subjectAlias, subjectIndexName } from './indices.ts';
import { subjectConsumer } from './consumer-name.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { searchIdentityWriterChanged } from './identity-epoch-participant-events.ts';
import nextSql from './identity-epoch-participant-next.sql';
import stepSql from './identity-epoch-participant-step.sql';
import advanceSql from './identity-epoch-participant-advance.sql';
import replaySql from './identity-epoch-participant-replay.sql';
import completeSql from './identity-epoch-participant-complete.sql';
import directorySql from './identity-epoch-participant-directory.sql';
import jobScopeSql from './identity-epoch-participant-job-scope.sql';
import enrollSql from './identity-search-receiving-enroll.sql';
import existingPlansSql from './identity-search-receiving-existing-plans.sql';
import { validSearchIdentityReceivingFrontier } from './identity-receiving-native-contract.ts';
import {
  commitSearchIdentityReceivingPlans,
  enrollSearchIdentityReceivingPlans,
} from './identity-search-receiving-source.ts';

export type { SearchReceivingConfiguration };

const participantStatementWork = (
  nativeRows: number,
  nativePoints: number,
  statements: number,
  bytes: number,
  emptySeeks: number,
): WorkDimensions =>
  Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows,
    nativePoints,
    witnessKeys: 0,
    statements,
    bytes,
    emptySeeks,
  });

function searchIdentityParticipantStatementCosts(): SearchReceivingWorkDeclaration['statements'] {
  return Object.freeze([
    Object.freeze({ sql: completeSql.sql, work: participantStatementWork(6, 6, 6, 4096, 0) }),
    Object.freeze({ sql: directorySql.sql, work: participantStatementWork(8, 8, 1, 16384, 1) }),
    Object.freeze({ sql: existingPlansSql.sql, work: participantStatementWork(100, 2, 1, 8192, 1) }),
    Object.freeze({ sql: jobScopeSql.sql, work: participantStatementWork(1, 1, 1, 256, 1) }),
    Object.freeze({ sql: enrollSql.sql, work: participantStatementWork(8, 8, 1, 16384, 1) }),
  ]);
}

/** Trusted Search receiving binding for the composition root: same-Pool Access, clock, generation-1
 * consumer/index and the six-operation production declaration plus this participant's SQL costs.
 */
export function searchIdentityReceivingComposition(options: {
  pool: Pool;
  search: OpenSearch;
  prefix: string;
  routeKey: Uint8Array;
  access: Access;
  clock: KernelClock;
  work: SearchReceivingWorkDeclaration;
}): {
  configuration: SearchReceivingConfiguration;
  work: SearchReceivingWorkDeclaration;
} {
  subjectAlias(options.prefix);
  if (!(options.routeKey instanceof Uint8Array) || options.routeKey.byteLength !== 32)
    throw new ConfigError('KERNEL_ROUTE_KEY');
  return Object.freeze({
    configuration: Object.freeze({
      pool: options.pool,
      routeKey: Uint8Array.from(options.routeKey),
      access: options.access,
      clock: options.clock,
      search: options.search,
      consumer: subjectConsumer(options.prefix, 1),
      index: subjectIndexName(options.prefix, 1),
    }),
    work: Object.freeze({
      statements: Object.freeze([...options.work.statements, ...searchIdentityParticipantStatementCosts()]),
      native: options.work.native,
    }),
  });
}

const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);

/** Trusted constructor and exact adopted callable. Source supplies the installed dependencies and
 * its transitive SQL declarations; neither a request nor a saved native plan can configure them.
 */
export function createSearchIdentityEpochParticipant(options: {
  search: OpenSearch;
  prefix: string;
  routeKey: Uint8Array;
  receiving?: Readonly<{
    configuration: SearchReceivingConfiguration;
    work: SearchReceivingWorkDeclaration;
  }>;
}): IdentityEpochStep {
  subjectAlias(options.prefix);
  if (!(options.routeKey instanceof Uint8Array) || options.routeKey.byteLength !== 32)
    throw new ConfigError('KERNEL_ROUTE_KEY');
  const configured =
    options.receiving &&
    Object.freeze({
      configuration: Object.freeze({
        ...options.receiving.configuration,
        routeKey: Uint8Array.from(options.receiving.configuration.routeKey),
      }),
      work: options.receiving.work,
    });
  if (
    configured &&
    (configured.configuration.search !== options.search ||
      !Buffer.from(configured.configuration.routeKey).equals(Buffer.from(options.routeKey)))
  )
    throw new TypeError('Search receiving composition differs from its trusted participant');
  const installed =
    configured &&
    installSearchIdentityReceivingNative(configured.configuration.pool, configured.work, configured.configuration);
  return async (pool, job) => {
    const ref = { jobId: job.jobId, epoch: job.epoch };
    if (typeof ref.epoch !== 'bigint' || ref.epoch <= 0n) throw new TypeError('Invalid native identity epoch');
    if (!configured || !installed || configured.configuration.pool !== pool)
      throw unavailable(
        'Source has not installed the same-Pool receiving Access, clock, physical owner and transitive work declaration',
      );
    const funded = activeIdentitySourceConsumerMaintenance(pool);
    const deadline = funded?.deadline ?? deadlineFor(1000);
    const token = currentIdentitySourceConsumerMaintenance(pool, deadline);
    const parent = identitySourceConsumerLibraryWork(pool, token ?? undefined, deadline);
    const allowance = identitySourceConsumerNativeWork(pool, token ?? undefined, deadline);
    if (!token || !parent || !allowance)
      throw unavailable('Search requires the original live Source maintenance frame');
    const axes = [
      'candidateKeys',
      'identityMetadataRows',
      'nativeRows',
      'nativePoints',
      'witnessKeys',
      'statements',
      'bytes',
      'emptySeeks',
    ] as const;
    const ceiling = Object.fromEntries(axes.map((axis) => [axis, parent.available(axis)])) as unknown as WorkDimensions;
    return (
      await (
        await installed
      ).run({ deadline, identityConsumerWork: token, ceiling, allowance }, async () => {
        const saved = await withReadTransaction(pool, (tx) => identityEpochStore().readJob(tx, ref), deadline);
        if (!saved) throw unavailable('Search requires an exact admitted native job');
        const completed = saved.participants['search-canonical-index'];
        if (completed?.state === 'complete') {
          const r = completed.receipt;
          if (
            r.step !== 'search-canonical-index' ||
            r.version !== 1 ||
            r.job.jobId !== ref.jobId ||
            r.job.epoch !== ref.epoch
          )
            throw unavailable('Search completion differs from the exact admitted job');
          const native = r.native;
          const retained = await withReadTransaction(
            pool,
            async (tx) =>
              (
                await tx.query(replaySql.sql, [
                  native.partition,
                  native.transactionId,
                  native.epoch,
                  String(native.position),
                  ref.jobId,
                  String(ref.epoch),
                  identityJobPartition(ref),
                ])
              ).rows[0],
            deadline,
          );
          if (
            !retained ||
            !validSearchIdentityReceivingFrontier(retained.frontier) ||
            !isDeepStrictEqual(retained.frontier, completed.frontier)
          )
            throw unavailable('Search completion lost its committed native frontier or current owner');
          // Reuse the original committed completion, never mint one from an empty local queue.
          // This path neither releases a hold nor conveys native release observation authority.
          return {
            ...completed,
            frontier: retained.frontier,
            work: used(allowance, identitySourceConsumerNativeWork(pool, token, deadline)),
          };
        }
        if (saved.state !== 'pending')
          throw unavailable('Unfinished Search cancellation requires the original Source writer disposition');
        if (saved.mapping?.state !== 'complete')
          throw unavailable('Search requires authoritative native mapping custody');
        await commitSearchIdentityReceivingPlans(pool, ref, configured.configuration, { deadline, allowance });
        const enrolled = await enrollSearchIdentityReceivingPlans(pool, ref);
        const row = await withReadTransaction(
          pool,
          async (tx) =>
            (await tx.query(nextSql.sql, [identityJobPartition(ref), ref.jobId, String(ref.epoch)])).rows[0],
          deadline,
        );
        if (!row) {
          const directory = await withReadTransaction(
            pool,
            async (tx) =>
              (
                await tx.query<{ pending: number; originals: number; plans: number }>(directorySql.sql, [
                  identityJobPartition(ref),
                  ref.jobId,
                  String(ref.epoch),
                ])
              ).rows[0],
            deadline,
          );
          if (
            !directory ||
            directory.pending !== 0 ||
            directory.originals < 1 ||
            directory.plans !== directory.originals ||
            enrolled !== 'ready'
          )
            throw unavailable(
              'Complete Source receiving-plan discovery and its sealed original/copy directory are not installed',
            );
          const roles = await identityErasureRoles(pool, ref.jobId);
          const frontier = { after: ['directory', directory.originals], segment: 0 };
          const scope = await withReadTransaction(
            pool,
            async (tx) =>
              (
                await tx.query<{ scope_digest: string }>(jobScopeSql.sql, [
                  identityJobPartition(ref),
                  ref.jobId,
                  String(ref.epoch),
                ])
              ).rows[0]?.scope_digest,
            deadline,
          );
          if (!scope) throw unavailable('Search completion lost the admitted job scope');
          const sealed = await runCommand(
            pool,
            { partition: identityJobPartition(ref), deadline, clock: configured.configuration.clock },
            async (tx) => {
              bindSemanticProducerRoles(tx, roles);
              recordIdentityEpochNativeCommit(tx, 'search-canonical-index');
              registerCommandCallback(tx, async (id) => {
                const inserted = await tx.query(completeSql.sql, [
                  currentCommand(tx).partition,
                  id,
                  ref.jobId,
                  String(ref.epoch),
                  scope,
                  json(frontier),
                  json(used(allowance, identitySourceConsumerNativeWork(pool, token, deadline))),
                ]);
                if (inserted.rowCount !== 1) throw unavailable('Search completion lost its native step');
              });
              return { value: null, events: searchIdentityWriterChanged() };
            },
          );
          return {
            job: ref,
            frontier,
            state: 'complete' as const,
            receipt: {
              job: ref,
              step: 'search-canonical-index' as const,
              version: 1 as const,
              native: {
                partition: sealed.partition,
                transactionId: sealed.transactionId,
                epoch: sealed.epoch,
                position: sealed.position,
              },
            },
            work: used(allowance, identitySourceConsumerNativeWork(pool, token, deadline)),
          };
        }
        const b = row.binding;
        const s = b?.source;
        if (
          b?.step !== 'search-canonical-index' ||
          !s ||
          b.scopeDigest !== row.scope_digest ||
          s.consumer !== configured.configuration.consumer ||
          s.physicalTarget !== configured.configuration.index
        )
          throw unavailable('Prepared scope differs from its configured native Search owner');
        const effect = await prepareSearchIdentityReceivingEffect(pool, {
          job: ref,
          original: b.original,
          owner: b.owner,
          effectKey: b.effectKey,
          sourceId: s.sourceId,
          scope: s.scope,
          disposition: s.disposition,
          native: s.locator,
        });
        const roles = await identityErasureRoles(pool, ref.jobId);
        const native = await runCommand<{ frontier: IdentityFrontier; receipt: IdentityNativeReceipt | null }>(
          pool,
          { partition: effect.receipt.partition, deadline, clock: configured.configuration.clock },
          async (tx) => {
            const record = await lookupIdentityReceivingEffect(tx, effect, 'search-canonical-index');
            if (!record) throw unavailable('Prepared original has no committed common/native acceptance');
            if (record.applied) return noEffect(record.applied);
            bindSemanticProducerRoles(tx, roles);
            const frontier = { after: [record.original, record.effectKey], segment: 0 };
            // Actual dispatch/visibility belongs to the sole writer. This fused application refuses
            // until that original operation is visibly settled; it never issues a second engine write.
            await recordIdentityReceivingEffect(tx, effect, { frontier });
            registerCommandCallback(tx, async (id) => {
              const work = used(allowance, identitySourceConsumerNativeWork(pool, token, deadline));
              const inserted = await tx.query(stepSql.sql, [
                currentCommand(tx).partition,
                id,
                ref.jobId,
                String(ref.epoch),
                record.scopeDigest,
                json(frontier),
                json(work),
              ]);
              if (inserted.rowCount !== 1) throw unavailable('Search application lost its same-transaction fixed step');
            });
            return { value: { frontier, receipt: null }, events: searchIdentityWriterChanged() };
          },
        );
        const applied = await reconcileIdentityReceivingEffect(pool, effect);
        const frontier = native.value.frontier;
        // Only a successful common reconcile (including fresh post-control native release) may
        // retire this operational key. A crash before this command leaves the exact scope queued
        // for accepted/applied/released replay. No cursor can skip a later lower-sorting plan.
        const progress = await runCommand(
          pool,
          { partition: identityJobPartition(ref), deadline, clock: configured.configuration.clock },
          async (tx) => {
            const retired = await tx.query(advanceSql.sql, [
              identityJobPartition(ref),
              ref.jobId,
              String(ref.epoch),
              b.effectKey,
              row.plan_transaction_id,
              row.binding_digest,
              applied.partition,
              applied.epoch,
              String(applied.position),
              applied.transactionId,
              row.scope_digest,
            ]);
            if (retired.rowCount !== 1) throw unavailable('Search scope progress lost exact committed control custody');
            bindSemanticProducerRoles(tx, roles);
            recordIdentityEpochNativeCommit(tx, 'search-canonical-index');
            registerCommandCallback(tx, async (id) => {
              const inserted = await tx.query(stepSql.sql, [
                currentCommand(tx).partition,
                id,
                ref.jobId,
                String(ref.epoch),
                row.scope_digest,
                json(frontier),
                json(used(allowance, identitySourceConsumerNativeWork(pool, token, deadline))),
              ]);
              if (inserted.rowCount !== 1)
                throw unavailable('Search scope progress and its native step must commit together');
            });
            return { value: null, events: searchIdentityWriterChanged() };
          },
        );
        return {
          job: ref,
          frontier,
          state: 'more',
          receipt: {
            job: ref,
            step: 'search-canonical-index',
            version: 1,
            native: {
              partition: progress.partition,
              transactionId: progress.transactionId,
              epoch: progress.epoch,
              position: progress.position,
            },
          },
          work: used(allowance, identitySourceConsumerNativeWork(pool, token, deadline)),
        } satisfies IdentityStepProgress;
      })
    ).value;
  };
}

function used(before: NativeStepWork, after: NativeStepWork | null): NativeStepWork {
  if (!after) throw unavailable('The original native work frame ended before Search settlement');
  return {
    rows: before.rows - after.rows,
    points: before.points - after.points,
    statements: before.statements - after.statements,
    bytes: before.bytes - after.bytes,
    engineRequests: before.engineRequests - after.engineRequests,
  };
}
