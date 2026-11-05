import { memoizedValue } from '../memoized.ts';
import { defineQuery } from 'reylo';
import type { AccessClient } from '../request/access.ts';
import statement from './write-rate-counter.sql';

// Keep Reylo's SQL-derived types and execution, without its periodic catalog
// freshness query. Schema compatibility is checked at build/deploy; every spend,
// including the first one on a new connection, must execute only the upsert.
function spend() {
  return memoizedValue(spend, () =>
    defineQuery<
      (typeof statement)['~reylo']['input'],
      (typeof statement)['~reylo']['element'],
      typeof statement.cardinality,
      'postgres'
    >({
      dialect: statement.dialect,
      sql: statement.raw,
      params: statement.params,
      cardinality: statement.cardinality,
    }),
  );
}

/** Internal storage primitive. The trusted stage supplies the verified acting
 * account's canonical route or the anonymous digest's tuple-home route, plus
 * identity and current budget. This primitive preserves that supplied placement. */
export async function spendWriteRateCounter(
  client: AccessClient,
  input: {
    route: number;
    identityDigest: string;
    accountId?: string | null;
    family: string;
    units: number;
    budget: { maximum: number; seconds: number };
  },
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const { route, identityDigest, family, units, budget } = input;
  if (
    !Number.isInteger(route) ||
    route < 0 ||
    route > 65535 ||
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
  const [row] = await spend().run(client, {
    route,
    identity_digest: identityDigest,
    account_id: input.accountId ?? '',
    family,
    admitted_units: units <= budget.maximum ? units : 0,
    maximum: budget.maximum,
    seconds: budget.seconds,
  });
  if (!row || row.allowed === null || row.retryAfter === null) throw new Error('Write rate counter unavailable');
  return row.allowed ? { allowed: true } : { allowed: false, retryAfter: row.retryAfter };
}
