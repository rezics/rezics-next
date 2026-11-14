import { afterAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
import { readSubjectReference } from '../../src/semantic/references.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { observeSql, type SqlObserver } from '../content/support/sql-observer.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
afterAll(async () => { await pool.end(); });

function statementTimeout(observer: SqlObserver, from: number) {
  const record = observer.records.slice(from).find(({ statement }) => /SET LOCAL statement_timeout/.test(statement));
  if (!record) throw new Error('Expected the native read transaction to set statement_timeout');
  const match = /statement_timeout\s*=\s*'(\d+)ms'/.exec(record.statement);
  if (!match) throw new Error('Expected a finite native statement_timeout');
  return { milliseconds: Number(match[1]), recordedAt: Date.parse(record.executedAt) };
}

test('Subject reference transactions preserve explicit, default and inherited deadlines', async () => {
  const observer = observeSql(pool);
  const id = newId(4160);
  try {
    const requestDeadline = Date.now() + 5_000;
    const explicitStart = observer.records.length;
    await readSubjectReference(pool, id, async () => true, requestDeadline);
    const explicit = statementTimeout(observer, explicitStart);
    expect(Math.abs(explicit.milliseconds - (requestDeadline - explicit.recordedAt))).toBeLessThan(100);

    const defaultStart = observer.records.length;
    await readSubjectReference(pool, id, async () => true);
    const defaultBudget = statementTimeout(observer, defaultStart).milliseconds;
    expect(defaultBudget).toBeGreaterThan(0);
    expect(defaultBudget).toBeLessThanOrEqual(DEFAULT_REQUEST_DEADLINE_MS);

    const inheritedDeadline = Date.now() + 1_500;
    const inheritedStart = observer.records.length;
    await withReadTransaction(
      pool,
      () => readSubjectReference(pool, id, async () => true, Date.now() + 10_000),
      inheritedDeadline,
    );
    const inherited = statementTimeout(observer, inheritedStart);
    expect(inherited.milliseconds).toBeGreaterThan(0);
    expect(inherited.milliseconds).toBeLessThanOrEqual(inheritedDeadline - inherited.recordedAt);
  } finally {
    await observer.close();
  }
});

test('an expired Subject reference deadline rejects before native checkout', async () => {
  let checkouts = 0;
  const noCheckoutPool = {
    async connect() {
      checkouts++;
      throw new Error('unexpected native checkout');
    },
  } as unknown as Pool;
  await expect(
    readSubjectReference(noCheckoutPool, newId(4160), async () => true, Date.now() - 1),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
  expect(checkouts).toBe(0);
});
