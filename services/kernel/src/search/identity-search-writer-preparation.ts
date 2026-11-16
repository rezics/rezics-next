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
} from './identity-search-receiving-directory.ts';
import { readSearchIdentityWriterAdmissionSql } from './identity-search-receiving-directory-sql.ts';
import { searchIdentityWorkContext, searchIdentityWorkUsed } from './identity-search-receiving-work.ts';
import { readSearchIdentityOriginalPlan } from './identity-search-receiving-source.ts';
import { subjectPartition } from './source.ts';
import { createSearchWriterGuard } from './writer-guard.ts';

const unavailable = (message: string) => new IdentityEpochStoreError('identity_epoch_unavailable', message);

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
              const { directory, change } = await withReadTransaction(
                pool,
                async (tx) => {
                  const directory = await readSearchIdentityDirectory(tx, job);
                  const selected = directory.writerRequest;
                  if (
                    !selected ||
                    native.partition !== selected.native.partition ||
                    native.transactionId !== selected.native.transactionId ||
                    native.epoch !== selected.native.epoch ||
                    native.position !== selected.native.position
                  )
                    throw unavailable('Search writer request is no longer the retained current step');
                  const change = await readSearchIdentityDirectoryOriginal(tx, job, directory);
                  if (!change || change.original !== selected.original || change.terminal !== selected.terminal)
                    throw unavailable('Search writer request no longer selects the admitted original');
                  return { directory, change };
                },
                context.deadline,
              );
              if (await readSearchIdentityOriginalPlan(pool, job, change, configuration, context.deadline))
                return 'prepared' as const;

              const { original } = change;
              const partition = subjectPartition(original);
              const admitted = async (tx: CommandTransaction) => {
                const row = (
                  await tx.query<{ proven: boolean }>(readSearchIdentityWriterAdmissionSql, [
                    partition,
                    job.jobId,
                    String(job.epoch),
                    native.transactionId,
                    directory.scope,
                    original,
                  ])
                ).rows[0];
                if (row && !row.proven) throw unavailable('Retained writer admission moved or lost its original proof');
                return !!row;
              };
              if (await withReadTransaction(pool, admitted, context.deadline)) return 'pending' as const;

              // One allocation request belongs to this Search turn. No SQL connection spans it.
              const allocation = await outsideSource(() =>
                readSearchWriterPhysicalTarget(turn.search(configuration.search), configuration.index),
              );
              const roles = await identityErasureRoles(pool, job.jobId);
              await runCommand(
                pool,
                { partition, deadline: context.deadline, clock: configuration.clock },
                async (tx) => {
                  if (await admitted(tx)) return noEffect(null);
                  const observation = await writer.observeIdentityPreparation(tx, job, original, allocation);
                  bindSemanticProducerRoles(tx, roles);
                  recordIdentityEpochNativeCommit(tx, 'search-canonical-index');
                  registerCommandCallback(tx, async (id) => {
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
                    const result = await tx.query(stepSql.sql, [
                      currentCommand(tx).partition,
                      id,
                      job.jobId,
                      String(job.epoch),
                      directory.scope,
                      json(frontier),
                      json({ ...searchIdentityWorkUsed(pool, context), engineRequests: 1 }),
                    ]);
                    if (result.rowCount !== 1) throw unavailable('Search writer admission lost its native step');
                  });
                  return { value: null, events: searchIdentityWriterChanged() };
                },
              );
              return 'pending' as const;
            })
          ).value;
        });
      });
    } finally {
      turn.close();
    }
  };
}
