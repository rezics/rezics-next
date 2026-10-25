import { defineQuery } from 'reylo';
import type { AccessClient } from '../request/access.ts';
import statement from './write-rate-counter.sql';

// Keep Reylo's SQL-derived types and execution, without its periodic catalog
// freshness query. Schema compatibility is checked at build/deploy; every spend,
// including the first one on a new connection, must execute only the upsert.
const spend = defineQuery<
  (typeof statement)['~reylo']['input'],
  (typeof statement)['~reylo']['element'],
  typeof statement.cardinality,
  'postgres'
>({
  dialect: statement.dialect,
  sql: statement.raw,
  params: statement.params,
  cardinality: statement.cardinality,
});

/** Internal storage primitive. The trusted write stage supplies identity and current budget. */
export async function spendWriteRateCounter(
  client: AccessClient,
  input: {
    identityDigest: string;
    family: string;
    units: number;
    budget: { maximum: number; seconds: number };
  },
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const { identityDigest, family, units, budget } = input;
  if (
    typeof identityDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(identityDigest) ||
    typeof family !== 'string' ||
    !/^[a-z][a-z0-9_.:-]{0,63}$/.test(family) ||
    !Number.isInteger(units) ||
    units < 1 ||
    units > 100 ||
    !Number.isInteger(budget.maximum) ||
    budget.maximum < 1 ||
    budget.maximum > 2147483647 ||
    !Number.isInteger(budget.seconds) ||
    budget.seconds < 1 ||
    budget.seconds > 172800
  )
    throw new RangeError('Invalid write rate counter input');
  const row = await spend.run(client, {
    identity_digest: identityDigest,
    family,
    admitted_units: units <= budget.maximum ? units : 0,
    maximum: budget.maximum,
    seconds: budget.seconds,
  });
  if (!row || row.allowed === null || row.retryAfter === null) throw new Error('Write rate counter unavailable');
  return row.allowed ? { allowed: true } : { allowed: false, retryAfter: row.retryAfter };
}
