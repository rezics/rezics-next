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
  type SearchReceivingWorkDeclaration,
} from '../semantic/identity-receiving-effects.ts';
import { subjectSource } from '../semantic/search-source.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  withIdentitySourceConsumerMaintenance,
} from '../semantic/identity-source-consumer-maintenance.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { admitSearchTurn, runSearchTurn } from './generations.ts';
import { searchIdentityWriterChanged } from './identity-epoch-participant-events.ts';
import { readSearchWriterPhysicalTarget } from './identity-epoch-participant-physical.ts';
import stepSql from './identity-epoch-participant-step.sql';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import {
  readSearchIdentityDirectory,
  readSearchIdentityDirectoryOriginal,
  requireCurrentSearchIdentityDirectory,
} from './identity-search-receiving-directory.ts';
import { readSearchIdentityWriterAdmissionSql } from './identity-search-receiving-directory-sql.ts';
import { searchIdentityWorkContext, searchIdentityWorkUsed } from './identity-search-receiving-work.ts';
import { readSearchIdentityOriginalPlan } from './identity-search-receiving-source.ts';
import { subjectPartition } from './source.ts';
import { createSearchWriterGuard } from './writer-guard.ts';
import { createSearchIdentityWriterSupport } from './identity-search-writer-support.ts';

const unavailable = (message: string) => new IdentityEpochStoreError('identity_epoch_unavailable', message);

function retainWriterStep(
  tx: CommandTransaction,
  pool: Pool,
  job: IdentityJobRef,
  scope: string,
  roles: Awaited<ReturnType<typeof identityErasureRoles>>,
  frontier: IdentityFrontier,
  context: ReturnType<typeof searchIdentityWorkContext>,
  engineRequests: number,
) {
  bindSemanticProducerRoles(tx, roles);
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

              const { original } = change;
              const partition = subjectPartition(original);
              const admitted = async (tx: CommandTransaction) => {
                const row = (
                  await tx.query<{ proven: boolean; transaction_id: string }>(readSearchIdentityWriterAdmissionSql, [
                    partition,
                    job.jobId,
                    String(job.epoch),
                    native.transactionId,
                    directory.scope,
                    original,
                  ])
                ).rows[0];
                if (row && !row.proven) throw unavailable('Retained writer admission moved or lost its original proof');
                return row?.transaction_id ?? null;
              };
              if (await withReadTransaction(pool, admitted, context.deadline)) {
                const support = await resumeSupport(
                  { job, change, request: native.transactionId, scope: directory.scope, release: directory.release },
                  context.deadline,
                );
                if (!support) {
                  const plan = await readSearchIdentityOriginalPlan(pool, job, change, configuration, context.deadline);
                  return { state: plan ? 'prepared' : 'pending' } as const;
                }
                const roles = await identityErasureRoles(pool, job.jobId);
                const committed = await runCommand(
                  pool,
                  { partition, deadline: context.deadline, clock: configuration.clock },
                  async (tx) => {
                    if (!(await admitted(tx))) throw unavailable('Search writer lost its retained admission');
                    await support.compare(tx);
                    retainWriterStep(tx, pool, job, directory.scope, roles, support.frontier, context, 0);
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
              const roles = await identityErasureRoles(pool, job.jobId);
              const committed = await runCommand<string | null>(
                pool,
                { partition, deadline: context.deadline, clock: configuration.clock },
                async (tx) => {
                  const prior = await admitted(tx);
                  if (prior) return noEffect(prior);
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
