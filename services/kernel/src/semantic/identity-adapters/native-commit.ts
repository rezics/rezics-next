import type { CommandTransaction } from '../../command/command.ts';
import { IdentityEpochStoreError } from '../contract/identity-errors.ts';
import { nativeIdentityCapabilities } from '../identity-adapter-bind.ts';
import type { NativeIdentityCapabilities } from '../identity-adapter-port.ts';
import storeInsertNativeCommit from '../identity-epoch-store-insert-native-commit.sql';

const nativeCommitPurposes = new WeakMap<CommandTransaction, string>();

/** One callback and one purpose per native transaction, shared by all capability-bound callers. */
export function createIdentityNativeCommitRecorder(capabilities: NativeIdentityCapabilities) {
  const cmd = () => capabilities.command;
  return function recordIdentityEpochNativeCommit(tx: CommandTransaction, purpose: string): void {
    const command = cmd().currentCommand(tx);
    const prior = nativeCommitPurposes.get(tx);
    if (prior) {
      if (prior !== purpose) throw new TypeError('Conflicting identity native commit purposes');
      return;
    }
    nativeCommitPurposes.set(tx, purpose);
    cmd().registerCommandCallback(tx, async (transactionId) => {
      const result = await tx.query(storeInsertNativeCommit.sql, [command.partition, transactionId, purpose]);
      if (result.rowCount !== 1)
        throw new IdentityEpochStoreError(
          'identity_epoch_unavailable',
          'Identity source, native group generation or bootstrap closure is not current',
        );
    });
  };
}

export function recordIdentityEpochNativeCommit(tx: CommandTransaction, purpose: string): void {
  createIdentityNativeCommitRecorder(nativeIdentityCapabilities())(tx, purpose);
}
