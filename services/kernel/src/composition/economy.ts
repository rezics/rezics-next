import type { Pool } from 'pg';
import { classifyUnavailability } from '../access/unavailable.ts';
import { BoundedReadDeadlineError, withBoundedCommandConnection, withBoundedReadConnection } from '../database/pool.ts';
import type { EconomyLedger, EconomyResult } from '../economy/contract.ts';
import { createEconomyLedger } from '../economy/ledger.ts';

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

export function createNativeEconomyLedger(pool: Pool, bookId: string): EconomyLedger {
  return createEconomyLedger(
    {
      transaction: (work) =>
        classify(() =>
          withBoundedCommandConnection(pool, Date.now() + budgetMillis, async (client) => {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
          }),
        ),
      read: (work) => classify(() => withBoundedReadConnection(pool, Date.now() + budgetMillis, work)),
    },
    bookId,
  );
}
