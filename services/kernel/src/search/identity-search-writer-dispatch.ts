import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { runCommand } from '../command/command.ts';
import { IdentityEpochStoreError } from '../semantic/contract/identity-errors.ts';
import { bindSemanticProducerRoles, identityErasureRoles } from '../semantic/erasure-producer.ts';
import type { IdentityJobRef } from '../semantic/identity-epoch-contract.ts';
import { identitySourceConsumerNativeWork } from '../semantic/identity-source-consumer-maintenance.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { SearchIdentityReceivingSelection } from './identity-receiving-native-contract.ts';
import type { StoredSource } from './identity-receiving-native-internal.ts';
import type { SearchReceivingConfiguration } from './identity-receiving-native.ts';
import { createSearchIdentityReceivingNativeStore } from './identity-receiving-native-store.ts';
import {
  readBoundedSearchIdentityActionSql,
  readSearchIdentityDispatchBasisSql,
  searchIdentityWriterBodyBytes,
} from './identity-search-writer-dispatch-sql.ts';
import type { searchIdentityWorkContext } from './identity-search-receiving-work.ts';
import { searchIdentityWriterChanged } from './identity-epoch-participant-events.ts';
import { readSearchWriterPhysicalTarget } from './identity-epoch-participant-physical.ts';
import type { OpenSearch } from './opensearch.ts';
import { decodeSearchIdentityWriterAction, type SearchWriterNativeCustody } from './writer-guard.ts';
import { validateIndexWriteReceipt, writeIndexActions } from './write-actions.ts';

const unavailable = (message: string) => new IdentityEpochStoreError('identity_epoch_unavailable', message);

export async function readSearchIdentityDispatchBasis(
  pool: Pool,
  job: IdentityJobRef,
  selection: SearchIdentityReceivingSelection,
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
          action_digest: string;
          action_bytes: number;
          accepted_epoch: number;
          accepted_position: string;
          accepted_transaction_id: string;
          state: 'dispatched' | 'visible' | 'applied' | null;
          visible: boolean;
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
    row.source.documentId !== selection.owner ||
    row.source.locator.planId !== selection.native.planId ||
    row.source.terminal === undefined ||
    (row.state === 'visible' || row.state === 'applied') !== row.visible ||
    searchIdentityWriterBodyBytes(row.action_bytes) === undefined ||
    !/^[1-9][0-9]*$/.test(row.accepted_position) ||
    row.accepted_epoch !== row.source.receivingEpoch ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.accepted_transaction_id)
  )
    throw unavailable('Search writer requires the exact original plan, action and accepted hold');
  return row;
}

export async function advanceSearchIdentityDispatch(
  configuration: SearchReceivingConfiguration,
  writer: SearchWriterNativeCustody,
  store: ReturnType<typeof createSearchIdentityReceivingNativeStore>,
  job: IdentityJobRef,
  selection: SearchIdentityReceivingSelection,
  request: Readonly<{ planId: string; holdId: string }>,
  scope: string,
  context: ReturnType<typeof searchIdentityWorkContext>,
  engine: OpenSearch,
  outsideSource: <T>(body: () => T) => T,
) {
  const { pool, index, clock } = configuration;
  const { deadline } = context;
  const basis = await readSearchIdentityDispatchBasis(pool, job, selection, scope, index, deadline);
  if (!basis || selection.native.planId !== request.planId || basis.hold_id !== request.holdId)
    throw unavailable('Search writer dispatch request no longer names the accepted hold');
  if (basis.visible) return;
  if (basis.state !== null) throw unavailable('Search writer awaits the original uncertain dispatch result');

  const source = basis.source;
  const allocation = async () => {
    const actual = await readSearchWriterPhysicalTarget(engine, index);
    if (actual.incarnation !== source.incarnation || actual.writeAlias !== source.writeAlias)
      throw unavailable('Search physical allocation changed during identity dispatch');
  };
  const token = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const roles = await identityErasureRoles(pool, job.jobId);
  const command = { partition: source.receivingHome, deadline, clock };
  const remaining = () => {
    const allowance = identitySourceConsumerNativeWork(pool, context.identityConsumerWork, deadline);
    if (!allowance) throw unavailable('Search writer lost its admitted Source work');
    return { allowance, deadline };
  };
  await outsideSource(allocation);
  const { value } = await runCommand(pool, command, async (tx) => {
    const retained = (
      await tx.query<{ value: string | null; repair_locator: string }>(readBoundedSearchIdentityActionSql, [
        source.receivingHome,
        index,
        source.documentId,
        basis.action_bytes,
      ])
    ).rows[0];
    if (
      !retained?.value ||
      retained.repair_locator !== source.locator.planId ||
      createHash('sha256').update(retained.value).digest('hex') !== basis.action_digest
    )
      throw unavailable('Search writer lost the immutable action before dispatch');
    const action = decodeSearchIdentityWriterAction(retained.value, source);
    const dispatch = await writer.dispatchIdentityAction(tx, job, source, token);
    bindSemanticProducerRoles(tx, roles);
    await store.recordDispatch(tx, selection.native, basis.hold_id, operationId, remaining(), basis.action_bytes);
    // Settlement stores and reads back a receipt containing this exact action.
    if (remaining().allowance.bytes < 2 * searchIdentityWriterBodyBytes(basis.action_bytes)!)
      throw unavailable('Search writer lacks the retained body work needed for settlement');

    return { value: { action, dispatch }, events: searchIdentityWriterChanged() };
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
    await writeIndexActions(transport, index, [value.action], { rejectConflicts: true, writeAlias: source.writeAlias });
    validateIndexWriteReceipt(response, index, [value.action]);
    await allocation();
    return response;
  });
  await runCommand(pool, command, async (tx) => {
    const bytes = await writer.settleIdentityAction(tx, job, source, token, value.dispatch, value.action, bulk);
    bindSemanticProducerRoles(tx, roles);
    await store.recordVisible(tx, selection.native, basis.hold_id, operationId, remaining(), bytes);
    return { value: null, events: searchIdentityWriterChanged() };
  });
}
