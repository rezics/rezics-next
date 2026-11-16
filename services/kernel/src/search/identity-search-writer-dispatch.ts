import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  currentCommand,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import { recordIdentityEpochNativeCommit } from '../semantic/identity-adapters/identity-epoch-binding.ts';
import { bindSemanticProducerRoles, identityErasureRoles } from '../semantic/erasure-producer.ts';
import type { IdentityJobRef, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import { identitySourceConsumerNativeWork } from '../semantic/identity-source-consumer-maintenance.ts';
import {
  prepareSearchIdentityReceivingReconciliation,
  applySearchIdentityReceivingEffect,
} from '../semantic/identity-receiving-effects.ts';
import { serializeIdentityValue as json } from '../semantic/identity-core/encoding.ts';
import type { IdentityReceivingEffect } from '../semantic/identity-receiving-effects-types.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { prepareRetainedIdentitySourceProjections } from '../semantic/search-source.ts';
import type { SearchIdentityReceivingSelection } from './identity-receiving-native-contract.ts';
import type { StoredReferences, StoredSource } from './identity-receiving-native-internal.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { createSearchIdentityReceivingNativeStore } from './identity-receiving-native-store.ts';
import {
  readBoundedSearchIdentityActionSql,
  readSearchIdentityBulkResponseSql,
  readSearchIdentityDispatchBasisSql,
  retainSearchIdentityBulkResponseSql,
  SEARCH_IDENTITY_BULK_RESPONSE_BYTES,
  searchIdentityWriterBodyBytes,
} from './identity-search-writer-dispatch-sql.ts';
import { searchIdentityWorkUsed, type searchIdentityWorkContext } from './identity-search-receiving-work.ts';
import stepSql from './identity-epoch-participant-step.sql';
import { searchIdentityWriterChanged } from './identity-epoch-participant-events.ts';
import { readSearchWriterPhysicalTarget } from './identity-epoch-participant-physical.ts';
import type { OpenSearch } from './opensearch.ts';
import { subjectPartition } from './source.ts';
import { decodeSearchIdentityWriterAction, type SearchWriterNativeCustody } from './writer-guard.ts';
import { retainIndexWriteItem, validateIndexWriteReceipt, writeIndexActions } from './write-actions.ts';
import { verifyCanonicalIdentityDocumentAtDispatch } from './identity-search-writer-document.ts';

const unavailable = (message: string) => new IdentityEpochStoreError('identity_epoch_unavailable', message);

export async function readSearchIdentityDispatchBasis(
  pool: Pool,
  job: IdentityJobRef,
  selection: { native: { partition: number; planId: string }; original: string; terminal?: string },
  scope: string,
  index: string,
  deadline: number,
) {
  const row = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query<{
          hold_id: string;
          source: StoredSource;
          effect_key: string;
          action_digest: string;
          obligations: StoredReferences;
          action_bytes: number;
          accepted_epoch: number;
          accepted_position: string;
          accepted_transaction_id: string;
          state: 'dispatched' | 'visible' | 'applied' | null;
          visible: boolean;
          released: boolean;
        }>(readSearchIdentityDispatchBasisSql, [
          selection.native.partition,
          selection.native.planId,
          job.jobId,
          String(job.epoch),
          index,
          selection.original,
          scope,
        ])
      ).rows[0],
    deadline,
  );
  if (!row) return null;
  if (
    row.source.barrier.kind !== 'original' ||
    row.source.original !== selection.original ||
    row.source.documentId !== selection.original ||
    row.source.owner !== selection.original ||
    row.source.sourceId !== selection.original ||
    row.source.locator.planId !== selection.native.planId ||
    (selection.terminal !== undefined && row.source.terminal !== selection.terminal) ||
    row.source.receivingHome !== selection.native.partition ||
    typeof row.effect_key !== 'string' ||
    !row.effect_key ||
    Buffer.byteLength(row.effect_key) > 256 ||
    (row.state === 'visible' || row.state === 'applied') !== row.visible ||
    (row.released && row.state !== 'applied') ||
    searchIdentityWriterBodyBytes(row.action_bytes) === undefined ||
    !/^[1-9][0-9]*$/.test(row.accepted_position) ||
    row.accepted_epoch !== row.source.receivingEpoch ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.accepted_transaction_id)
  )
    throw unavailable('Search writer requires the exact original plan, action and accepted hold');
  return row;
}

export function searchIdentityDispatchEffect(
  job: IdentityJobRef,
  selection: Pick<SearchIdentityReceivingSelection, 'original' | 'effectKey' | 'native'>,
  basis: NonNullable<Awaited<ReturnType<typeof readSearchIdentityDispatchBasis>>>,
): IdentityReceivingEffect {
  return {
    kind: 'receiving',
    job,
    original: selection.original,
    effectKey: selection.effectKey,
    receipt: {
      partition: selection.native.partition,
      transactionId: basis.accepted_transaction_id,
      epoch: basis.accepted_epoch,
      position: BigInt(basis.accepted_position),
    },
  };
}

/** The receiving effect and its fixed step share the same native command. */
export function applySearchIdentityWriterStep(
  configuration: SearchReceivingConfiguration,
  effect: IdentityReceivingEffect,
  planId: string,
  scopeDigest: string,
  context: ReturnType<typeof searchIdentityWorkContext>,
  roles: Awaited<ReturnType<typeof identityErasureRoles>>,
) {
  const { pool, clock, consumer, index } = configuration;
  const command = { partition: effect.receipt.partition, deadline: context.deadline, clock };
  return runCommand<IdentityNativeReceipt | null>(pool, command, async (tx) => {
    const applied = await applySearchIdentityReceivingEffect(
      tx,
      effect,
      { scopeDigest, consumer, physicalTarget: index, planId },
      roles,
    );
    if (applied.receipt) return noEffect(applied.receipt);
    registerCommandCallback(tx, async (id) => {
      const saved = await tx.query(stepSql.sql, [
        currentCommand(tx).partition,
        id,
        effect.job.jobId,
        String(effect.job.epoch),
        applied.scopeDigest,
        json(applied.frontier),
        json(searchIdentityWorkUsed(pool, context)),
      ]);
      if (saved.rowCount !== 1) throw unavailable('Search application lost its same-transaction fixed step');
    });
    return { value: null, events: searchIdentityWriterChanged() };
  });
}

export async function advanceSearchIdentityDispatch(
  configuration: SearchReceivingConfiguration,
  writer: SearchWriterNativeCustody,
  store: ReturnType<typeof createSearchIdentityReceivingNativeStore>,
  job: IdentityJobRef,
  request: Readonly<{ planId: string; holdId: string; original: string; terminal: string }>,
  scope: string,
  context: ReturnType<typeof searchIdentityWorkContext>,
  engine: OpenSearch,
  outsideSource: <T>(body: () => T) => T,
) {
  const { pool, index, clock } = configuration;
  const { deadline } = context;
  const { basis, roles, reconcile } = await withReadTransaction(
    pool,
    async () => {
      const basis = await readSearchIdentityDispatchBasis(
        pool,
        job,
        {
          original: request.original,
          terminal: request.terminal,
          native: { partition: subjectPartition(request.original), planId: request.planId },
        },
        scope,
        index,
        deadline,
      );
      if (!basis || basis.hold_id !== request.holdId || basis.source.consumer !== configuration.consumer)
        throw unavailable('Search writer dispatch request no longer names the accepted hold');
      const reconcile = basis.state === 'applied' && !basis.released
        ? await prepareSearchIdentityReceivingReconciliation(pool, searchIdentityDispatchEffect(job, {
            original: basis.source.original, effectKey: basis.effect_key, native: basis.source.locator,
          }, basis))
        : null;
      return {
        basis,
        roles: basis.state === null || basis.state === 'visible' ? await identityErasureRoles(pool, job.jobId) : [],
        reconcile,
      };
    },
    deadline,
  );
  if (reconcile) return reconcile();
  const { source, action_digest: actionDigest, action_bytes: actionBytes } = basis;
  const selection: SearchIdentityReceivingSelection = {
    job,
    original: source.original,
    effectKey: basis.effect_key,
    owner: source.owner,
    sourceId: source.sourceId,
    scope: source.scope,
    disposition: source.disposition,
    native: source.locator,
  };
  if (basis.state === 'visible') {
    const effect = searchIdentityDispatchEffect(job, selection, basis);
    const applied = await applySearchIdentityWriterStep(configuration, effect, request.planId, scope, context, roles);
    return { state: 'progress', transactionId: applied.value?.transactionId ?? applied.transactionId } as const;
  }
  if (basis.visible) return { state: 'prepared' } as const;
  const allocation = async () => {
    const actual = await readSearchWriterPhysicalTarget(engine, index);
    if (actual.incarnation !== source.incarnation || actual.writeAlias !== source.writeAlias)
      throw unavailable('Search physical allocation changed during identity dispatch');
  };
  const command = { partition: source.receivingHome, deadline, clock };
  const remaining = () => {
    const allowance = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline);
    if (!allowance) throw unavailable('Search writer lost its admitted Source work');
    return { allowance, deadline };
  };
  const bulkKey = [source.receivingHome, index, source.documentId, source.locator.planId, basis.hold_id] as const;
  async function loadAction(tx: CommandTransaction) {
    const retained = (
      await tx.query<{ value: string | null; repair_locator: string }>(readBoundedSearchIdentityActionSql, [
        source.receivingHome,
        index,
        source.documentId,
        actionBytes,
      ])
    ).rows[0];
    if (
      !retained?.value ||
      retained.repair_locator !== source.locator.planId ||
      createHash('sha256').update(retained.value).digest('hex') !== actionDigest
    )
      throw unavailable('Search writer lost the immutable action before dispatch');
    return decodeSearchIdentityWriterAction(retained.value, source);
  }
  if (basis.state === 'dispatched') {
    const retained = await withReadTransaction(
      pool,
      async (tx) => {
        const [response] = (
          await tx.query<{
            operation_id: string;
            writer_token: string;
            dispatch_transaction_id: string;
            dispatch_epoch: number;
            dispatch_position: string;
            bulk: unknown;
          }>(readSearchIdentityBulkResponseSql, [...bulkKey])
        ).rows;
        if (!response) throw unavailable('Search writer awaits the original uncertain dispatch result');
        const action = await loadAction(tx);
        validateIndexWriteReceipt(response.bulk, index, [action]);
        return { response, action, roles: await identityErasureRoles(pool, job.jobId) };
      },
      deadline,
    );
    const { response, action } = retained;
    const dispatch: IdentityNativeReceipt = {
      partition: source.receivingHome,
      epoch: response.dispatch_epoch,
      transactionId: response.dispatch_transaction_id,
      position: BigInt(response.dispatch_position),
    };
    await outsideSource(allocation);
    const visible = await runCommand(pool, command, async (tx) => {
      const bytes = await writer.settleIdentityAction(
        tx,
        job,
        source,
        response.writer_token,
        dispatch,
        action,
        response.bulk,
      );
      bindSemanticProducerRoles(tx, retained.roles);
      await store.recordVisible(tx, selection.native, request.holdId, response.operation_id, remaining(), bytes);
      return { value: null, events: searchIdentityWriterChanged() };
    });
    return { state: 'progress', transactionId: visible.transactionId } as const;
  }
  if (basis.state !== null) throw unavailable('Search writer awaits the original uncertain dispatch result');

  const originalSupport = source.original === source.terminal ? basis.obligations.originalSupport : null;
  const support = originalSupport && { ...originalSupport, generation: BigInt(originalSupport.generation) };
  const verify =
    support &&
    (await prepareRetainedIdentitySourceProjections(configuration, {
      job,
      original: source.original,
      terminal: source.terminal,
      release: basis.obligations.release,
      originalSupport: support,
      terminalSupport: support,
      deadline,
    }));
  const token = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  await outsideSource(allocation);
  const { value } = await runCommand(pool, command, async (tx) => {
    const action = await loadAction(tx);
    if (
      action.op === 'index' &&
      (!verify ||
        !(await verify(tx)) ||
        !(await verifyCanonicalIdentityDocumentAtDispatch(
          tx,
          action.document,
          configuration,
          basis.obligations.statementInput,
        )))
    )
      throw unavailable('Canonical Search Source changed before dispatch');
    await writer.dispatchIdentityAction(tx, job, source, token);
    bindSemanticProducerRoles(tx, roles);
    await store.recordDispatch(tx, selection.native, basis.hold_id, operationId, remaining(), basis.action_bytes);
    return { value: action, events: searchIdentityWriterChanged() };
  });

  // A lost response leaves the committed dispatch uncertain. No readback can settle it.
  const bulk = await outsideSource(async () => {
    let response: unknown;
    const transport: OpenSearch = {
      ...engine,
      async bulk<T>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]) {
        const result = await engine.bulk<T>(lines, options);
        response = result;
        return result;
      },
    };
    await writeIndexActions(transport, index, [value], { rejectConflicts: true, writeAlias: source.writeAlias });
    return retainIndexWriteItem(response, index, value);
  });

  const retained = await runCommand(pool, command, async (tx) => {
    const response = JSON.stringify({
      kind: 'identity-original-bulk',
      transaction: currentCommand(tx).transactionId,
      bulk,
    });
    if (Buffer.byteLength(response) > SEARCH_IDENTITY_BULK_RESPONSE_BYTES)
      throw unavailable('Original Search bulk response exceeds retained custody');
    const written = await tx.query(retainSearchIdentityBulkResponseSql, [...bulkKey, operationId, token, response]);
    if (written.rowCount !== 1) throw unavailable('Search writer lost its original bulk response');
    recordIdentityEpochNativeCommit(tx, 'search-canonical-index');
    return { value: null, events: searchIdentityWriterChanged() };
  });
  return { state: 'progress', transactionId: retained.transactionId } as const;
}
