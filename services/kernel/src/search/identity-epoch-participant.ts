import { ConfigError } from '../commerce/config.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { currentCommand, noEffect, registerCommandCallback, runCommand } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import type { IdentitySourceSupportReaderFactory } from '../semantic/index.ts';
import type {
  IdentityEpochStep,
  IdentityStepProgress,
  IdentityNativeReceipt,
} from '../semantic/identity-epoch-contract.ts';
import { bindSemanticProducerRoles, identityErasureRoles } from '../semantic/erasure-producer.ts';
import { identityEpochStore } from '../semantic/identity-adapters/index.ts';
import { identityJobPartition } from '../semantic/identity-adapters/identity-epoch-contract.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import { recordIdentityEpochNativeCommit } from '../semantic/identity-adapters/identity-epoch-binding.ts';
import { serializeIdentityValue as json } from '../semantic/identity-core/encoding.ts';
import {
  installSearchIdentityReceivingNative,
  lookupIdentityReceivingEffect,
  prepareSearchIdentityReceivingEffect,
  reconcileIdentityReceivingEffect,
  type SearchReceivingWorkDeclaration,
} from '../semantic/identity-receiving-effects.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { WorkDimensions } from '../library/contract/work-dimensions.ts';
import { subjectAlias, subjectIndexName } from './indices.ts';
import { subjectConsumer } from './consumer-name.ts';
import type { OpenSearch } from './opensearch.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { searchIdentityWriterChanged } from './identity-epoch-participant-events.ts';
import stepSql from './identity-epoch-participant-step.sql';
import replaySql from './identity-epoch-participant-replay.sql';
import completeSql from './identity-epoch-participant-complete.sql';
import {
  type SearchIdentityReceivingBinding,
  validSearchIdentityReceivingFrontier,
} from './identity-receiving-native-contract.ts';
import {
  readRetainedWriterCopySql,
  searchIdentityWriterAdmissionSql,
  searchIdentityWriterSettlementSql,
} from './writer-guard.ts';
import {
  advanceWriterPublicationAdmissionSql,
  lockPublicationFence,
  insertWriterPublicationWitness,
  lockPublicationAdmission,
  readPublicationFence,
  readWriterPublicationWitness,
} from './publication-admission.ts';
import { readSearchIdentityOriginalPlan } from './identity-search-receiving-source.ts';
import { searchIdentityWorkContext, searchIdentityWorkUsed } from './identity-search-receiving-work.ts';
import {
  advanceSearchIdentityDirectory,
  readSearchIdentityDirectory,
  readSearchIdentityDirectoryOriginal,
  requireCurrentSearchIdentityDirectory,
  requestSearchIdentityWriter,
  type SearchWriterPlanRequest,
} from './identity-search-receiving-directory.ts';
import {
  advanceSearchIdentityOriginalSql,
  readSearchIdentityCommonPlanSql,
  readSearchIdentityDirectorySql,
  readSearchIdentityMaterializedOriginalSql,
  readSearchIdentityOriginalPlanSql,
  searchIdentityOriginalPlanPresentSql,
  readSearchIdentityWriterAdmissionSql,
  recheckSearchIdentityWriterAdmissionSql,
  readSearchIdentityWriterSupportSql,
} from './identity-search-receiving-directory-sql.ts';

import {
  lockSearchIdentityOriginalSql,
  readSearchIdentityPlanComponentSql,
  revalidateSearchIdentityPlanFenceSql,
  readSearchIdentityPredecessorSql,
} from './identity-search-writer-plan-sql.ts';

import {
  dispatchSearchIdentityOriginalSql,
  readSearchIdentityBulkResponseSql,
  readSearchIdentityPlanBodySizeSql,
  readSearchIdentityDispatchBasisSql,
  retainSearchIdentityBulkResponseSql,
} from './identity-search-writer-dispatch-sql.ts';
import {
  applySearchIdentityWriterStep,
  readSearchIdentityDispatchBasis,
  searchIdentityDispatchEffect,
} from './identity-search-writer-dispatch.ts';
import { searchNativeOriginalOperationSql, searchNativeReleaseAppliedSql } from './identity-receiving-native-work.ts';
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
  const writer = searchIdentityWriterAdmissionSql();
  return Object.freeze([
    Object.freeze({ sql: completeSql.sql, work: participantStatementWork(6, 6, 6, 4096, 0) }),
    Object.freeze({ sql: readSearchIdentityDirectorySql, work: participantStatementWork(4, 4, 1, 4096, 1) }),
    Object.freeze({ sql: readSearchIdentityMaterializedOriginalSql, work: participantStatementWork(1, 1, 1, 1024, 1) }),
    Object.freeze({ sql: readSearchIdentityOriginalPlanSql, work: participantStatementWork(16, 12, 1, 20480, 1) }),
    Object.freeze({ sql: searchIdentityOriginalPlanPresentSql, work: participantStatementWork(4, 4, 1, 1024, 4) }),
    Object.freeze({ sql: readSearchIdentityCommonPlanSql, work: participantStatementWork(4, 4, 1, 16384, 1) }),
    Object.freeze({ sql: advanceSearchIdentityOriginalSql, work: participantStatementWork(9, 9, 1, 16384, 1) }),
    Object.freeze({ sql: readRetainedWriterCopySql, work: participantStatementWork(3, 3, 1, 1024, 1) }),
    ...(
      [
        [readSearchIdentityWriterAdmissionSql, 3, 3, 4096],
        [recheckSearchIdentityWriterAdmissionSql, 1, 1, 2048],
        [readSearchIdentityWriterSupportSql, 3, 3, 4096],
        [lockSearchIdentityOriginalSql, 1, 1, 2048],
        [readSearchIdentityPlanComponentSql, 1, 1, 512],
        [revalidateSearchIdentityPlanFenceSql, 5, 5, 2048],
        [searchNativeOriginalOperationSql(), 4, 4, 4096],
        [searchNativeReleaseAppliedSql(), 4, 4, 2048],
        [readSearchIdentityPredecessorSql, 6, 6, 4096],
        [readSearchIdentityDispatchBasisSql, 9, 9, 20480],
        [dispatchSearchIdentityOriginalSql, 1, 1, 1024],
        [retainSearchIdentityBulkResponseSql, 2, 2, 12288],
        [readSearchIdentityBulkResponseSql, 4, 4, 12288],
        [readSearchIdentityPlanBodySizeSql, 1, 1, 512],
        [searchIdentityWriterSettlementSql(), 1, 1, 2048],
        [lockPublicationAdmission, 1, 1, 512],
        [lockPublicationFence, 1, 1, 512],
        [advanceWriterPublicationAdmissionSql, 1, 1, 512],
        [readWriterPublicationWitness, 1, 1, 512],
        [insertWriterPublicationWitness, 1, 1, 512],
        [readPublicationFence, 1, 1, 512],
        [writer.gate, 1, 1, 1024],
        [writer.insertGate, 1, 1, 1024],
        [writer.original, 1, 1, 1024],
      ] as const
    ).map(([sql, rows, points, bytes]) =>
      Object.freeze({
        sql,
        work: participantStatementWork(rows, points, 1, bytes, 1),
      }),
    ),
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
  identitySourceSupportReaderFactory: IdentitySourceSupportReaderFactory;
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
      identitySourceSupportReaderFactory: options.identitySourceSupportReaderFactory,
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
    const context = searchIdentityWorkContext(pool);
    const { deadline } = context;
    return (
      await (
        await installed
      ).run(context, async () => {
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
            work: searchIdentityWorkUsed(pool, context),
          };
        }
        if (saved.state !== 'pending')
          throw unavailable('Unfinished Search cancellation requires the original Source writer disposition');
        if (saved.mapping?.state !== 'complete')
          throw unavailable('Search requires authoritative native mapping custody');
        const { directory, change } = await withReadTransaction(
          pool,
          async (tx) => {
            const directory = await readSearchIdentityDirectory(tx, ref);
            const change = await readSearchIdentityDirectoryOriginal(tx, ref, directory);
            return { directory, change };
          },
          deadline,
        );
        const request = directory.writerRequest;
        if (request && (!change || change.original !== request.original || change.terminal !== request.terminal))
          throw unavailable('Retained Search writer request differs from the admitted original');
        if (!change) {
          if (directory.count < 1) throw unavailable('Search receiving has no completed original to seal');
          const roles = await identityErasureRoles(pool, ref.jobId);
          const frontier = { after: ['directory', directory.count], segment: 0 };
          const sealed = await runCommand(
            pool,
            { partition: identityJobPartition(ref), deadline, clock: configured.configuration.clock },
            async (tx) => {
              await requireCurrentSearchIdentityDirectory(tx, ref, directory);
              if (await readSearchIdentityDirectoryOriginal(tx, ref, directory))
                throw unavailable('Search receiving directory still has an original to process');
              bindSemanticProducerRoles(tx, roles);
              recordIdentityEpochNativeCommit(tx, 'search-canonical-index');
              registerCommandCallback(tx, async (id) => {
                const inserted = await tx.query(completeSql.sql, [
                  currentCommand(tx).partition,
                  id,
                  ref.jobId,
                  String(ref.epoch),
                  directory.scope,
                  json(frontier),
                  json(searchIdentityWorkUsed(pool, context)),
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
            work: searchIdentityWorkUsed(pool, context),
          };
        }
        const configuration = configured.configuration;
        const plan = await readSearchIdentityOriginalPlan(pool, ref, change, configuration, deadline);
        const stageWriter = async (wanted?: SearchWriterPlanRequest) => {
          if (
            request?.plan &&
            (!wanted ||
              request.plan.planId !== wanted.planId ||
              (request.plan.holdId && request.plan.holdId !== wanted.holdId))
          )
            throw unavailable('Retained writer request no longer matches the original plan and hold');
          const replay =
            request &&
            Boolean(request.plan) === Boolean(wanted) &&
            Boolean(request.plan?.holdId) === Boolean(wanted?.holdId)
              ? request
              : undefined;
          const frontier =
            replay?.frontier ?? requestSearchIdentityWriter(directory, change.original, change.terminal, wanted);
          let native = replay?.native;
          if (!native) {
            const roles = await identityErasureRoles(pool, ref.jobId);
            const staged = await runCommand(
              pool,
              { partition: identityJobPartition(ref), deadline, clock: configuration.clock },
              async (tx) => {
                await requireCurrentSearchIdentityDirectory(tx, ref, directory);
                if (!wanted) {
                  const original = await readSearchIdentityDirectoryOriginal(tx, ref, directory);
                  if (!original || original.original !== change.original || original.terminal !== change.terminal)
                    throw unavailable('Search writer request changed before commit');
                }
                bindSemanticProducerRoles(tx, roles);
                recordIdentityEpochNativeCommit(tx, 'search-canonical-index');
                registerCommandCallback(tx, async (id) => {
                  const inserted = await tx.query(stepSql.sql, [
                    currentCommand(tx).partition,
                    id,
                    ref.jobId,
                    String(ref.epoch),
                    directory.scope,
                    json(frontier),
                    json(searchIdentityWorkUsed(pool, context)),
                  ]);
                  if (inserted.rowCount !== 1) throw unavailable('Search writer request lost its native step');
                });
                return { value: null, events: searchIdentityWriterChanged() };
              },
            );
            native = {
              partition: staged.partition,
              transactionId: staged.transactionId,
              epoch: staged.epoch,
              position: staged.position,
            };
          }
          return {
            job: ref,
            frontier,
            state: 'more',
            receipt: { job: ref, step: 'search-canonical-index', version: 1, native },
            work: searchIdentityWorkUsed(pool, context),
          } satisfies IdentityStepProgress;
        };
        if (!plan) return stageWriter();
        const { selection } = plan;
        const dispatch = plan.originalBarrier
          ? await readSearchIdentityDispatchBasis(pool, ref, selection, directory.scope, configuration.index, deadline)
          : null;
        if (plan.originalBarrier) {
          if (!dispatch) return stageWriter({ planId: selection.native.planId });
          if (dispatch.effect_key !== selection.effectKey || dispatch.source.consumer !== configuration.consumer)
            throw unavailable('Retained dispatch differs from the selected original plan');
          if (!dispatch.released)
            return stageWriter({ planId: selection.native.planId, holdId: dispatch.hold_id });
        }
        const effect = dispatch
          ? searchIdentityDispatchEffect(ref, selection, dispatch)
          : await prepareSearchIdentityReceivingEffect(pool, selection);
        const roles = await identityErasureRoles(pool, ref.jobId);
        let applied: IdentityNativeReceipt;
        if (dispatch) {
          const observed = await runCommand(
            pool,
            { partition: effect.receipt.partition, deadline, clock: configuration.clock },
            async (tx) => {
              const record = await lookupIdentityReceivingEffect(tx, effect, 'search-canonical-index');
              if (
                !record?.applied || record.scopeDigest !== directory.scope ||
                record.source.locator.planId !== selection.native.planId
              )
                throw unavailable('Released scope lost its applied receipt');
              return noEffect(record.applied.receipt);
            },
          );
          applied = observed.value;
        } else {
          await applySearchIdentityWriterStep(
            configuration,
            effect,
            selection.native.planId,
            directory.scope,
            context,
            roles,
          );
          applied = await reconcileIdentityReceivingEffect(pool, effect);
        }
        const row = await withReadTransaction(
          pool,
          async (tx) =>
            (
              await tx.query<{
                binding: SearchIdentityReceivingBinding;
                binding_digest: string;
                plan_transaction_id: string;
                scope_digest: string;
              }>(readSearchIdentityCommonPlanSql, [
                identityJobPartition(ref),
                ref.jobId,
                String(ref.epoch),
                selection.effectKey,
              ])
            ).rows[0],
          deadline,
        );
        const binding = row?.binding;
        if (
          !row ||
          binding?.step !== 'search-canonical-index' ||
          binding.original !== change.original ||
          binding.effectKey !== selection.effectKey ||
          binding.scopeDigest !== directory.scope ||
          row.scope_digest !== directory.scope ||
          binding.source.consumer !== configuration.consumer ||
          binding.source.physicalTarget !== configuration.index
        )
          throw unavailable('Prepared scope differs from its configured native Search owner');
        const frontier = advanceSearchIdentityDirectory(directory, change.original);
        // Releasing custody and retiring its pending key comes before moving past this original.
        // A lost response reuses the still-selected original or reads the committed checkpoint.
        const progress = await runCommand(
          pool,
          { partition: identityJobPartition(ref), deadline, clock: configured.configuration.clock },
          async (tx) => {
            await requireCurrentSearchIdentityDirectory(tx, ref, directory);
            const retired = await tx.query(advanceSearchIdentityOriginalSql, [
              identityJobPartition(ref),
              ref.jobId,
              String(ref.epoch),
              selection.effectKey,
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
                json(searchIdentityWorkUsed(pool, context)),
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
          work: searchIdentityWorkUsed(pool, context),
        } satisfies IdentityStepProgress;
      })
    ).value;
  };
}
