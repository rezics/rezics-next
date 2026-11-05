import type { CommandTransaction } from '../command/command.ts';
import { currentCommand } from '../command/command.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import insertNativeCommit from './identity-epoch-store-insert-native-commit.sql';
import selectNativeCommit from './identity-scoped-consumer-native.sql';

/** Materialize the existing executor-native component in the caller's transaction.
 * A returned locator is uncommitted until that command commits; it grants no authority.
 * This uses the same partition lock and component allocator as the original writer.
 */
export async function writeIdentityScopeConsumerNativeCommit(tx: CommandTransaction): Promise<IdentityNativeReceipt> {
  const command = currentCommand(tx);
  const prior = await tx.query<{ purpose: string }>(selectNativeCommit.sql, [command.partition, command.transactionId]);
  if (prior.rows.length) throw new TypeError('Scope consumer fence requires its own native component');
  const inserted = await tx.query(insertNativeCommit.sql, [
    command.partition,
    command.transactionId,
    'identity-scope-finish',
  ]);
  if (inserted.rowCount !== 1) throw new TypeError('Scope consumer fence lost its native owner');
  const row = (
    await tx.query<{ epoch: number; position: string }>(selectNativeCommit.sql, [
      command.partition,
      command.transactionId,
    ])
  ).rows[0];
  if (!row) throw new TypeError('Scope consumer fence has no native component');
  return Object.freeze({
    partition: command.partition,
    epoch: row.epoch,
    position: BigInt(row.position),
    transactionId: command.transactionId,
  });
}
