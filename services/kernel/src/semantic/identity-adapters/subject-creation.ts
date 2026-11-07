import type { CommandTransaction } from '../../command/command.ts';
import { readPartition } from '../../partition/partition.ts';
import { routeOf, partitionOf } from '../../route/route.ts';
import { IdentityEpochStoreError } from '../contract/identity-errors.ts';
import { nativeIdentityCapabilities } from '../identity-adapter-bind.ts';
import type { NativeIdentityCapabilities } from '../identity-adapter-port.ts';
import type { IdentityEpochStore } from './identity-epoch-contract.ts';
import storeSelectSubject2 from '../identity-epoch-store-select-subject-2.sql';
import storeSelectMapping3 from '../identity-epoch-store-select-mapping-3.sql';
import storeInsertGroup from '../identity-epoch-store-insert-group.sql';
import storeInsertMapping from '../identity-epoch-store-insert-mapping.sql';
import storeInsertHomeGate from '../identity-epoch-store-insert-home-gate.sql';
import storeInsertOriginal from '../identity-epoch-store-insert-original.sql';
import storeUpdateDirty from '../identity-epoch-store-update-dirty.sql';

const unavailable = () =>
  new IdentityEpochStoreError(
    'identity_epoch_unavailable',
    'Identity source, native group generation or bootstrap closure is not current',
  );

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Identity original must be a native routed ID');
  return value;
}

/** Same-transaction birth mapping; no identity job or participant is loaded or inferred. */
export function createIdentitySubjectInitializer(
  capabilities: NativeIdentityCapabilities,
): IdentityEpochStore['initializeSubject'] {
  const cmd = () => capabilities.command;
  return async (tx, original) => {
    const command = cmd().currentCommand(tx);
    const originalRoute = route(original);
    if (command.partition !== partitionOf(originalRoute)) throw new TypeError('Wrong subject creation home');
    if (
      command.basis !== null &&
      (!command.authorization ||
        command.authorization.action !== 'subject:create' ||
        command.authorization.mode !== 'execute')
    )
      throw new TypeError('Exact self requires native subject:create authorization');
    const source = (await tx.query(storeSelectSubject2.sql, [originalRoute, original])).rows[0];
    if (!source) throw new TypeError('initializeSubject requires the same native creation transaction');
    // A birth mapping is tied to the actual source-home fence that commits revision 1. Zero is
    // not a current epoch, and a process-local/default value would let a moved home look current.
    const owner = await readPartition(tx, command.partition);
    if (!owner || owner.writeState !== 'active') throw unavailable();
    const existing = (await tx.query(storeSelectMapping3.sql, [originalRoute, original])).rows[0];
    if (existing) {
      if (
        existing.terminal === original &&
        existing.owner_epoch === owner.epoch &&
        BigInt(existing.epoch) > 0n &&
        existing.origin === 'creation' &&
        existing.recorded_transaction_id === source.recorded_transaction_id &&
        existing.gate_transaction_id === source.recorded_transaction_id &&
        !existing.pending_job &&
        existing.pending_epoch === null
      )
        return;
      throw new TypeError('Identity self mapping already exists outside this exact creation transaction');
    }
    const header = (await tx.query(storeInsertGroup.sql, [command.partition, original, owner.epoch])).rows[0];
    if (!header) throw unavailable();
    await tx.query(storeInsertMapping.sql, [
      originalRoute,
      original,
      owner.epoch,
      source.recorded_transaction_id,
      command.partition,
      header.published_epoch,
    ]);
    await tx.query(storeInsertHomeGate.sql, [
      originalRoute,
      original,
      header.published_epoch,
      source.recorded_transaction_id,
    ]);
    await tx.query(storeInsertOriginal.sql, [command.partition, header.generation, original]);
    await tx.query(storeUpdateDirty.sql, [originalRoute, original]);
    cmd().registerCommandCallback(tx, async (transactionId) => {
      if (transactionId !== source.recorded_transaction_id)
        throw new TypeError('initializeSubject requires the executor native creation transaction');
    });
  };
}

export function initializeIdentitySubject(tx: CommandTransaction, original: string): Promise<void> {
  return createIdentitySubjectInitializer(nativeIdentityCapabilities())(tx, original);
}
