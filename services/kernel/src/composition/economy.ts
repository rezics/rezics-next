import type { Pool } from 'pg';
import { lockNativeEconomyAdmission } from '../access/index.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { BoundedReadDeadlineError, withBoundedCommandConnection, withBoundedReadConnection } from '../database/pool.ts';
import type { EconomyLedger, EconomyResult, EconomyWalletPort } from '../economy/contract.ts';
import { createEconomyLedger, type EconomyDatabase } from '../economy/ledger.ts';
import { ProblemError } from '../http/problem-error.ts';

const budgetMillis = 2_000;

async function classify<T>(run: () => Promise<EconomyResult<T>>): Promise<EconomyResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof BoundedReadDeadlineError ||
      classifyUnavailability(error) !== undefined ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].some((code) => code === error.code))
    ) {
      return { kind: 'unavailable' };
    }
    throw error;
  }
}

export function createNativeEconomyDatabase(pool: Pool, requestDeadline = Number.POSITIVE_INFINITY): EconomyDatabase {
  const deadline = () => Math.min(requestDeadline, Date.now() + budgetMillis);
  return {
    transaction: (work) =>
      classify(() =>
        withBoundedCommandConnection(pool, deadline(), async (client) => {
          await client.query('BEGIN');
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        }),
      ),
    read: (work) => classify(() => withBoundedReadConnection(pool, deadline(), work)),
  };
}

/** Book-owner storage for test issuance and source-bound settlement. Private HTTP uses the wallet port below. */
export function createNativeEconomyLedger(pool: Pool, bookId: string): EconomyLedger {
  return createEconomyLedger(createNativeEconomyDatabase(pool), bookId);
}

export function createNativeEconomyWallet(
  pool: Pool,
  { bookId, node }: { bookId: string; node: string },
): EconomyWalletPort {
  const database = createNativeEconomyDatabase(pool);
  function admitted<T>(
    parties: { accountId: string; recipientId?: string },
    operation: (ledger: EconomyWalletPort) => Promise<EconomyResult<T>>,
  ): Promise<EconomyResult<T>> {
    return database.transaction<T>(async (client) => {
      const admission = await lockNativeEconomyAdmission(client, { node, ...parties });
      if (admission === 'unavailable') return { kind: 'unavailable' };
      if (admission === 'source_denied') throw new ProblemError('platform_closed');
      if (admission === 'recipient_denied') throw new ProblemError('not_found');
      // The closed-over connection retains the owner locks until the outer commit.
      const ledger = createEconomyLedger({ transaction: (work) => work(client), read: (work) => work(client) }, bookId);
      return operation(ledger);
    });
  }
  return {
    readBalance: (input) => admitted({ accountId: input.accountId }, (ledger) => ledger.readBalance(input)),
    readStatement: (input) => admitted({ accountId: input.accountId }, (ledger) => ledger.readStatement(input)),
    transfer: (input) =>
      admitted({ accountId: input.accountId, recipientId: input.recipientId }, (ledger) => ledger.transfer(input)),
  };
}
