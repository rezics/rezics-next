import type { CommandTransaction } from '../command/command.ts';
import { type AccountReference, validateScope } from './locator.ts';
import seal from './seal.sql';

export class HistorySealedError extends Error {
  constructor() {
    super('Account history is sealed');
    this.name = 'HistorySealedError';
  }
}

/** Stable order, bounded materialization, then SHARE through commit, including an empty prefix. */
export async function guardHistoryAccounts(
  tx: CommandTransaction,
  partition: number,
  accounts: readonly AccountReference[],
) {
  validateScope('command-receipt/v1', { artifactType: 'command-receipt/v1', accounts });
  for (const account of [...accounts].sort(
    (a, b) => a.accountRoute - b.accountRoute || a.accountId.localeCompare(b.accountId),
  )) {
    const args = [partition, account.accountRoute, account.accountId];
    await tx.query(
      `INSERT INTO core.history_seal(partition_no,account_route,account_id)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      args,
    );
    const row = await tx.query(
      `SELECT phase FROM core.history_seal
      WHERE partition_no=$1 AND account_route=$2 AND account_id=$3 FOR SHARE`,
      args,
    );
    if (row.rows[0]?.phase !== 'open') throw new HistorySealedError();
  }
}

/** The FK binds the irreversible local seal to permanent native erasure, never caller text. */
export async function sealHistoryAccount(
  tx: CommandTransaction,
  partition: number,
  accountRoute: number,
  accountId: string,
) {
  const rows = await seal.run(tx, { partition_no: partition, account_route: accountRoute, account_id: accountId });
  if (rows.length !== 1) throw new TypeError('Missing committed erasure obligation');
}
