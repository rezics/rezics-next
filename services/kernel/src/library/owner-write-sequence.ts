import { currentCommand, registerCommandCallback, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import advance from './owner-write-sequence.sql';

export async function allocateOwnerWriteSeq(tx: CommandTransaction, accountId: string): Promise<bigint> {
  const command = currentCommand(tx);
  const route = routeOf(accountId);
  if (route === null || accountId.length !== 36) throw new TypeError('Invalid owner account route');
  if (command.partition !== partitionOf(route)) throw new TypeError('Owner belongs to another command partition');
  if (command.authorization?.mode !== 'execute' || command.basis?.actorAccountId !== accountId)
    throw new TypeError('Owner allocation requires an authorized same-owner command');
  // This guard prevents noEffect from concealing domain writes; it supplies no ordering.
  registerCommandCallback(tx, () => {});
  await tx.query(
    `INSERT INTO library.owner_write_counter (route, account_id, seq) VALUES ($1, $2, 0)
     ON CONFLICT (route, account_id) DO NOTHING`,
    [route, accountId],
  );
  const row = await advance.run(tx, { route, account_id: accountId });
  if (!row) throw new Error('Owner write counter disappeared');
  const seq = BigInt(row.seq);
  if (seq <= 0n) throw new RangeError('Owner write sequence must be positive');
  return seq;
}
