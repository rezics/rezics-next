import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import {
  currentCommand,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { subjectListingSource } from '../library/listing-counts.ts';
import type { SearchCurrentnessPort } from '../semantic/contract/domain-ports.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import { bindSemanticProducerRoles, identityErasureRoles } from '../semantic/erasure-producer.ts';
import { recordIdentityEpochNativeCommit } from '../semantic/identity-adapters/identity-epoch-binding.ts';
import { identityEpochStore } from '../semantic/identity-adapters/index.ts';
import type { IdentityFrontier, IdentityJobRef } from '../semantic/identity-epoch-contract.ts';
import { serializeIdentityValue as json } from '../semantic/identity-core/encoding.ts';
import {
  installSearchIdentityReceivingNative,
  advanceSearchIdentityReceivingAcceptance,
  searchIdentityWriterCheckpointRoles,
  type SearchReceivingWorkDeclaration,
} from '../semantic/identity-receiving-effects.ts';
import { subjectSource } from '../semantic/search-source.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  identitySourceConsumerNativeWork,
  withIdentitySourceConsumerMaintenance,
} from '../semantic/identity-source-consumer-maintenance.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { admitSearchTurn, runSearchTurn } from './generations.ts';
import { searchIdentityWriterChanged } from './identity-epoch-participant-events.ts';
import { readSearchWriterPhysicalTarget } from './identity-epoch-participant-physical.ts';
import stepSql from './identity-epoch-participant-step.sql';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { createSearchIdentityReceivingNativeStore } from './identity-receiving-native-store.ts';
import {
  snapshotSearchIdentityReceivingFrontier,
  type SearchIdentityReceivingSelection,
} from './identity-receiving-native-contract.ts';
import {
  readSearchIdentityDirectory,
  readSearchIdentityDirectoryOriginal,
  requireCurrentSearchIdentityDirectory,
} from './identity-search-receiving-directory.ts';
import {
  readSearchIdentityWriterAdmissionSql,
  recheckSearchIdentityWriterAdmissionSql,
} from './identity-search-receiving-directory-sql.ts';
import { searchIdentityWorkContext, searchIdentityWorkUsed } from './identity-search-receiving-work.ts';
import { readSearchIdentityOriginalPlan, searchIdentityWriterEffectKey } from './identity-search-receiving-source.ts';
import { subjectPartition } from './source.ts';
import { createSearchWriterGuard, type SearchIdentityWriterAdmission } from './writer-guard.ts';
import { createSearchIdentityWriterSupport } from './identity-search-writer-support.ts';
import { advanceSearchIdentityDispatch } from './identity-search-writer-dispatch.ts';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { prepareCanonicalIdentityDocument } from './identity-search-writer-document.ts';

const unavailable = (message: string) => new IdentityEpochStoreError('identity_epoch_unavailable', message);

function retainWriterStep(
  tx: CommandTransaction,
  pool: Pool,
  job: IdentityJobRef,
  scope: string,
  roles: Awaited<ReturnType<typeof identityErasureRoles>> | null,
  frontier: IdentityFrontier,
  context: ReturnType<typeof searchIdentityWorkContext>,
  engineRequests: number,
) {
  if (roles) bindSemanticProducerRoles(tx, roles);
  recordIdentityEpochNativeCommit(tx, 'search-canonical-index');
  registerCommandCallback(tx, async (id) => {
    const result = await tx.query(stepSql.sql, [
      currentCommand(tx).partition,
      id,
      job.jobId,
      String(job.epoch),
      scope,
      json(frontier),
      json({ ...searchIdentityWorkUsed(pool, context), engineRequests }),
    ]);
    if (result.rowCount !== 1) throw unavailable('Search writer lost its native preparation step');
  });
}

function readWriterAdmission(
  row: { transaction_id: string; frontier: unknown; proven: boolean },
  request: string,
  original: string,
): SearchIdentityWriterAdmission & { transactionId: string } {
  const frontier = snapshotSearchIdentityReceivingFrontier(row.frontier);
  const [kind, retainedRequest, retainedOriginal, incarnation, writeAlias, enrollment, fence, close] =
    frontier?.after ?? [];
  if (
    !row.proven ||
    frontier?.segment !== 0 ||
    frontier.after.length !== 8 ||
    kind !== 'search-writer-admitted' ||
    retainedRequest !== request ||
    retainedOriginal !== original ||
    typeof incarnation !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(incarnation) ||
    typeof writeAlias !== 'string' ||
    typeof enrollment !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(enrollment) ||
    typeof fence !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(fence) ||
    (close !== null && (typeof close !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(close)))
  )
    throw unavailable('Retained writer admission moved or lost its original proof');
  return {
    transactionId: row.transaction_id,
    incarnation,
    writeAlias,
    enrollmentGeneration: BigInt(enrollment),
    fenceGeneration: BigInt(fence),
    close,
  };
}

/** Worker-owned admission for the exact retained control request. Engine transport runs independently of Source accounting. */
export function createSearchIdentityWriterPreparation(
  { configuration, work }: { configuration: SearchReceivingConfiguration; work: SearchReceivingWorkDeclaration },
  env: Readonly<Record<string, string | undefined>>,
): NonNullable<SearchCurrentnessPort<Pool>['prepareCanonicalWriter']> {
  const installed = installSearchIdentityReceivingNative(configuration.pool, work, configuration);
  const writer = createSearchWriterGuard({
    ...configuration,
    source: subjectSource(configuration.pool, configuration.routeKey),
    listing: subjectListingSource(configuration.pool),
  });
  const resumeSupport = createSearchIdentityWriterSupport(configuration);
  const store = createSearchIdentityReceivingNativeStore(configuration);
  return async (pool, request) => {
    if (pool !== configuration.pool || activeIdentitySourceConsumerMaintenance(pool))
      throw unavailable('Search writer preparation requires the separate owner turn');
    if (request.step !== 'search-canonical-index' || request.version !== 1)
      throw unavailable('Search writer preparation requires the fixed Search request');
    const { job, native } = request;
    const turn = admitSearchTurn();
    try {
      return await runSearchTurn(turn, () => {
        const outsideSource = AsyncLocalStorage.snapshot();
        return withIdentitySourceConsumerMaintenance({ pool, env }, { deadline: turn.deadline }, async () => {
          const context = searchIdentityWorkContext(pool);
          return (
            await (
              await installed
            ).run(context, async () => {
              const directory = await withReadTransaction(
                pool,
                (tx) => readSearchIdentityDirectory(tx, job),
                context.deadline,
              );
              const change = directory.writerRequest;
              if (
                !change ||
                native.partition !== change.native.partition ||
                native.transactionId !== change.native.transactionId ||
                native.epoch !== change.native.epoch ||
                native.position !== change.native.position
              )
                throw unavailable('Search writer request is no longer the retained current step');

              if (change.plan?.holdId) {
                return advanceSearchIdentityDispatch(
                  configuration,
                  writer,
                  store,
                  job,
                  {
                    planId: change.plan.planId,
                    holdId: change.plan.holdId,
                    original: change.original,
                    terminal: change.terminal,
                  },
                  directory.scope,
                  context,
                  turn.search(configuration.search),
                  outsideSource,
                );
              }
              if (change.plan) {
                const allowance = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, context.deadline);
                if (!allowance) throw unavailable('Search writer acceptance lost its Source work frame');
                const { value: plan } = await store.readPlanPoint(
                  {
                    kind: 'search-canonical-index',
                    version: 1,
                    partition: subjectPartition(change.original),
                    planId: change.plan.planId,
                  },
                  { deadline: context.deadline, allowance },
                );
                if (
                  plan.selection.job.jobId !== job.jobId ||
                  plan.selection.job.epoch !== job.epoch ||
                  plan.scopeDigest !== directory.scope ||
                  plan.source.barrier.kind !== 'original' ||
                  plan.source.original !== change.original ||
                  plan.source.terminal !== change.terminal
                )
                  throw unavailable('Search writer request lost its exact prepared original');
                return advanceSearchIdentityReceivingAcceptance(
                  pool, plan, native.transactionId,
                  (tx, frontier, roles) => retainWriterStep(tx, pool, job, directory.scope, roles, frontier, context, 0),
                );
              }

              const { original } = change;
              const partition = subjectPartition(original);
              const admitted = async (tx: CommandTransaction) => {
                const row = (
                  await tx.query<{ proven: boolean; transaction_id: string; frontier: unknown }>(
                    readSearchIdentityWriterAdmissionSql,
                    [partition, job.jobId, String(job.epoch), native.transactionId, directory.scope, original],
                  )
                ).rows[0];
                return row ? readWriterAdmission(row, native.transactionId, original) : null;
              };
              const admission = await withReadTransaction(pool, admitted, context.deadline);
              if (admission) {
                const support = await resumeSupport(
                  { job, change, request: native.transactionId, scope: directory.scope, release: directory.release },
                  context.deadline,
                );
                if (support.state === 'ready') {
                  const plan = await readSearchIdentityOriginalPlan(
                    pool,
                    job,
                    change,
                    configuration,
                    context.deadline,
                    'preparation',
                  );
                  if (plan) return { state: 'prepared' } as const;
                  const redirected = original !== change.terminal;
                  const canonical = support.canonical
                    ? await prepareCanonicalIdentityDocument(
                        configuration,
                        job,
                        original,
                        support.canonical,
                        context.deadline,
                        (actions) =>
                          outsideSource(() =>
                            prepareBoundedSortKeys(turn.search(configuration.search), configuration.index, actions),
                          ),
                      )
                    : null;
                  if (!redirected && support.originalSupport && !canonical) return { state: 'pending' } as const;
                  const allocation = await outsideSource(() =>
                    readSearchWriterPhysicalTarget(turn.search(configuration.search), configuration.index),
                  );
                  if (
                    allocation.incarnation !== admission.incarnation ||
                    allocation.writeAlias !== admission.writeAlias
                  )
                    throw unavailable('Search writer allocation changed after retained admission');
                  const roles = canonical?.roles ?? (await identityErasureRoles(pool, job.jobId));
                  const locator = {
                    kind: 'search-canonical-index' as const,
                    version: 1 as const,
                    partition,
                    planId: crypto.randomUUID(),
                  };
                  await runCommand(
                    pool,
                    { partition, deadline: context.deadline, clock: configuration.clock },
                    async (tx) => {
                      if (canonical) {
                        const current = await tx.query(recheckSearchIdentityWriterAdmissionSql, [
                          partition,
                          admission.transactionId,
                          job.jobId,
                          String(job.epoch),
                          directory.scope,
                          json([
                            'search-writer-admitted',
                            native.transactionId,
                            original,
                            admission.incarnation,
                            admission.writeAlias,
                            String(admission.enrollmentGeneration),
                            String(admission.fenceGeneration),
                            admission.close,
                          ]),
                        ]);
                        if (current.rowCount !== 1) throw unavailable('Search writer lost its retained admission');
                      } else {
                        if ((await admitted(tx))?.transactionId !== admission.transactionId)
                          throw unavailable('Search writer lost its retained admission');
                        await support.compare(tx);
                      }
                      const retained = await writer.prepareIdentityAction(
                        tx,
                        job,
                        original,
                        locator.planId,
                        admission,
                        canonical?.document,
                      );
                      await canonical?.compare(tx, retained.close);
                      const disposition = redirected ? 'OLD' : retained.firstAbsence ? 'first-apply' : 'NEW';
                      const effectKey = searchIdentityWriterEffectKey(configuration.consumer, original, disposition);
                      const selection: SearchIdentityReceivingSelection = {
                        job,
                        original,
                        effectKey,
                        owner: original,
                        sourceId: original,
                        scope: effectKey,
                        disposition,
                        native: locator,
                      };
                      bindSemanticProducerRoles(tx, roles);
                      const allowance = identitySourceConsumerNativeWork(
                        pool,
                        context.identityConsumerWork,
                        context.deadline,
                      );
                      if (!allowance)
                        throw unavailable('Search writer original preparation lost its Source work frame');
                      await store.preparePlan(
                        tx,
                        {
                          selection,
                          scopeDigest: directory.scope,
                          source: {
                            locator,
                            original,
                            terminal: change.terminal,
                            documentId: original,
                            owner: original,
                            sourceId: original,
                            scope: effectKey,
                            disposition,
                            receivingHome: partition,
                            receivingEpoch: retained.close.epoch,
                            consumer: configuration.consumer,
                            physicalTarget: configuration.index,
                            incarnation: admission.incarnation,
                            writeAlias: admission.writeAlias,
                            physicalGeneration: retained.physicalGeneration,
                            enrollmentGeneration: retained.enrollmentGeneration,
                            fenceGeneration: retained.fenceGeneration,
                            barrier: { kind: 'original', partition, token: retained.close.transactionId },
                            originalFence: retained.close,
                          },
                          references: {
                            originalSupport: support.originalSupport,
                            terminalSupport: support.terminalSupport,
                            definition: support.definition,
                            release: support.release,
                            documentFence: retained.close,
                            predecessor: retained.previousPlan ? { ...locator, planId: retained.previousPlan } : null,
                            ...(canonical?.statementInput && { statementInput: canonical.statementInput }),
                          },
                          actionDigest: retained.actionDigest,
                          copies: retained.previousVisible
                            ? [
                                {
                                  state: 'settled',
                                  home: partition,
                                  consumer: configuration.consumer,
                                  physicalTarget: configuration.index,
                                  incarnation: admission.incarnation,
                                  writeAlias: admission.writeAlias,
                                  original,
                                  close: retained.close,
                                  enrollment: null,
                                  visible: retained.previousVisible,
                                },
                              ]
                            : [],
                        },
                        { deadline: context.deadline, allowance },
                      );
                      return { value: null, events: searchIdentityWriterChanged() };
                    },
                  );
                  return { state: 'prepared' } as const;
                }
                const roles = await searchIdentityWriterCheckpointRoles(pool, job, partition);
                const committed = await runCommand(
                  pool,
                  { partition, deadline: context.deadline, clock: configuration.clock },
                  async (tx) => {
                    if (!(await admitted(tx))) throw unavailable('Search writer lost its retained admission');
                    const frontier = snapshotSearchIdentityReceivingFrontier(await support.advance(tx));
                    if (!frontier)
                      throw unavailable('Search writer Source support exceeds its retained frontier bound');
                    retainWriterStep(tx, pool, job, directory.scope, roles, frontier, context, 0);
                    return { value: null, events: searchIdentityWriterChanged() };
                  },
                );
                return { state: 'progress', transactionId: committed.transactionId } as const;
              }

              await withReadTransaction(
                pool,
                async (tx) => {
                  await requireCurrentSearchIdentityDirectory(tx, job, directory);
                  const saved = await identityEpochStore().readJob(tx, job);
                  if (saved?.state !== 'pending' || saved.mapping?.state !== 'complete')
                    throw unavailable('Search writer requires an admitted job and completed mapping');
                  const selected = await readSearchIdentityDirectoryOriginal(tx, job, directory);
                  if (!selected || selected.original !== original || selected.terminal !== change.terminal)
                    throw unavailable('Search writer request no longer selects the admitted original');
                },
                context.deadline,
              );
              if (await readSearchIdentityOriginalPlan(pool, job, change, configuration, context.deadline))
                return { state: 'prepared' } as const;

              // One allocation request belongs to this Search turn. No SQL connection spans it.
              const allocation = await outsideSource(() =>
                readSearchWriterPhysicalTarget(turn.search(configuration.search), configuration.index),
              );
              const roles = await searchIdentityWriterCheckpointRoles(pool, job, partition);
              const committed = await runCommand<string | null>(
                pool,
                { partition, deadline: context.deadline, clock: configuration.clock },
                async (tx) => {
                  const prior = await admitted(tx);
                  if (prior) return noEffect(prior.transactionId);
                  const observation = await writer.observeIdentityPreparation(tx, job, original, allocation);
                  const frontier = {
                    after: [
                      'search-writer-admitted',
                      native.transactionId,
                      original,
                      allocation.incarnation,
                      allocation.writeAlias,
                      observation.enrollmentGeneration,
                      observation.fenceGeneration,
                      observation.close,
                    ],
                    segment: 0,
                  };
                  retainWriterStep(tx, pool, job, directory.scope, roles, frontier, context, 1);
                  return { value: null, events: searchIdentityWriterChanged() };
                },
              );
              return { state: 'progress', transactionId: committed.value ?? committed.transactionId } as const;
            })
          ).value;
        });
      });
    } finally {
      turn.close();
    }
  };
}
