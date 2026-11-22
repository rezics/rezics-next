import { Pool } from 'pg';
import { preparedStatementClient } from '../database/native-source-query.ts';
import { withBoundedCommandConnection } from '../database/pool.ts';
import { deadlineClient } from './deadline.ts';
import { AccessUnavailableError } from './unavailable.ts';
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

type CounterInput = {
  route: number;
  identityDigest: string;
  accountId?: string | null;
  family: string;
  units: number;
  budget: { maximum: number; seconds: number };
};

/** An independently leased idle session spends only the crash-resettable operational counter. */
export function spendPoolWriteRateCounter(pool: Pool, deadline: number, input: CounterInput) {
  if (!input.accountId || !(pool instanceof Pool)) return spendWriteRateCounter(deadlineClient(pool, deadline), input);
  return withBoundedCommandConnection(
    pool,
    deadline,
    (client) => spendCounter(client, input, client.getTransactionStatus() === 'I'),
    { deadlineError: () => new AccessUnavailableError('deadline') },
  );
}

/** A caller-owned client keeps the durability policy of its transaction. */
export function spendWriteRateCounter(client: AccessClient, input: CounterInput) {
  return spendCounter(client, input, false);
}

async function spendCounter(
  client: AccessClient,
  input: CounterInput,
  standalone: boolean,
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
  const counter = spend();
  const [row] = await counter.run(
    preparedStatementClient(client, counter['~standard'].query.text, 'access_write_rate_counter_v1'),
    {
      standalone,
      route,
      identity_digest: identityDigest,
      account_id: input.accountId ?? '',
      family,
      admitted_units: units <= budget.maximum ? units : 0,
      maximum: budget.maximum,
      seconds: budget.seconds,
    },
  );
  if (!row || row.allowed === null || row.retryAfter === null) throw new Error('Write rate counter unavailable');
  return row.allowed ? { allowed: true } : { allowed: false, retryAfter: row.retryAfter };
}
