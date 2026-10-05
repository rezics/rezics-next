import { fusekiReadBudget } from '../../../../services/main/src/infrastructure/fuseki.ts';

/** Nested Work read envelopes debit this outer budget. Background workers exit
 * the caller's budget, so their concurrent reads do not contaminate operation
 * cost assertions and remain running during the measurement. */
export async function measureGraphReads<T>(operation: () => Promise<T>): Promise<{ value: T; calls: number }> {
  const budget = { signal: AbortSignal.timeout(30_000), callsLeft: 1000, bytesLeft: Number.MAX_SAFE_INTEGER };
  const value = await fusekiReadBudget.run(budget, operation);
  return { value, calls: 1000 - budget.callsLeft };
}
