import type { Pool, PoolClient } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { WorkClient } from './client.ts';
import type { WorkScopedRequest } from './contract/index.ts';
import { ensureNativeWorkApplication } from './adapters/index.ts';

export { receiveOperationalWorkDestination as receiveOperationalHistoryWork } from '../history/operational-work-receiving.ts';
export type ScopedWorkRequest = WorkScopedRequest;

/** Origin intent and exact role-union custody commit with the source command. */
export async function stageHistoryWork(tx: CommandTransaction, input: ScopedWorkRequest): Promise<void> {
  return ensureNativeWorkApplication().stageHistoryWork(tx, input);
}

/** Actual legacy-named identity SDK executions use a newly persisted native custody UUID. */
export async function receiveMappedHistoryWork(
  tx: PoolClient,
  work: WorkClient,
  custodyId: string,
  source: { partition: number; transactionId: string },
  request: ScopedWorkRequest,
): Promise<'admitted' | 'retired'> {
  return ensureNativeWorkApplication().receiveMappedHistoryWork(tx, work, custodyId, source, request);
}

/** Kernel DBOS is schema dbos in this same configured database. Partition zero is its fixed receiving home. */
export async function receiveHistoryWork(
  pool: Pool,
  work: WorkClient,
  sourcePartition: number,
  workId: string,
): Promise<'admitted' | 'retired'> {
  return ensureNativeWorkApplication().receiveHistoryWork(pool, work, sourcePartition, workId);
}

/** Exact owning consumer handoff. Call in the transaction that completes/transfers the native obligation. */
export async function settleHistoryWork(
  tx: CommandTransaction,
  input: { partition: number; workId: string; digest: Uint8Array; owner: string },
): Promise<void> {
  return ensureNativeWorkApplication().settleHistoryWork(tx, input);
}
