import { randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { lookupEventType } from '../../src/events/catalogue.ts';
import { AccountFactPurgeDeniedError, purgeAccountFactsPage } from '../../src/library/account-fact-purge.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c61;
const time = '2026-10-27T12:00:00.000Z';

// Mechanical DAO fixtures only: these rows stand for an already terminal lifecycle.
async function terminalAccount() {
  const accountId = newId(route);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,transaction_id)
     VALUES($1,$2,'actor','deleted',true,$2)`,
    [route, accountId],
  );
  return accountId;
}

test('copy pages preserve exact microseconds and seek strictly by timestamp then id', async () => {
  const accountId = await terminalAccount();
  const ids = Array.from({ length: 4 }, () => newId(route)).sort();
  const expected = [ids[2]!, ids[3]!, ids[0]!, ids[1]!];
  const times = [
    '2026-10-27T12:00:00.000001Z',
    '2026-10-27T12:00:00.000001Z',
    '2026-10-27T12:00:00.000002Z',
    '2026-10-27T12:00:00.001000Z',
  ];
  for (const [index, copyId] of expected.entries())
    await pool.query(
      `INSERT INTO library.copy(route,copy_id,account_id,subject_id,status,note,revision,created_at,updated_at,transaction_id)
       VALUES($1,$2,$3,$3,'disposed','Private payload must never escape',1,$4,$4,$3)`,
      [route, copyId, accountId, times[index]],
    );
  let after: { id: string; createdAt?: string } | null = null;
  for (const [index, copyId] of expected.entries()) {
    const input = { accountId, kind: 'copy' as const, after, limit: 1, stepKey: randomUUID() };
    const result = await purgeAccountFactsPage({ pool, clock: () => new Date(time) }, input);
    expect(result.value).toEqual({
      examined: 1,
      removed: 1,
      after: { id: copyId, createdAt: times[index]! },
      exhausted: false,
    });
    expect(await purgeAccountFactsPage({ pool }, input)).toEqual({ ...result, replayed: true });
    const events = await pool.query(
      `SELECT type,subject,data FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq`,
      [result.partition, result.position.toString()],
    );
    expect(events.rows).toEqual([
      { type: 'com.rezics.library.copy.deleted.v1', subject: accountId, data: { copyId } },
      {
        type: 'com.rezics.library.account-facts.purged.v1',
        subject: accountId,
        data: { accountId, kind: 'copy', examined: 1, removed: 1 },
      },
    ]);
    after = result.value.after;
  }
  const empty = await purgeAccountFactsPage(
    { pool },
    { accountId, kind: 'copy', after, limit: 1, stepKey: randomUUID() },
  );
  expect(empty.value).toEqual({ examined: 0, removed: 0, after: null, exhausted: true });
  expect(
    (
      await pool.query('SELECT data FROM core.outbox WHERE partition_no=$1 AND position=$2', [
        empty.partition,
        empty.position.toString(),
      ])
    ).rows,
  ).toEqual([{ data: { accountId, kind: 'copy', examined: 0, removed: 0 } }]);
});

test('a full source page removes exactly 100 keys, emits 101 events and binds receipt input', async () => {
  const accountId = await terminalAccount();
  const subjects = Array.from({ length: 101 }, () => newId(route + 1)).sort();
  await pool.query(
    `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id)
     SELECT $1,$2,subject_id,'completed',1,$4,$4,$2 FROM unnest($3::uuid[]) AS subject_id`,
    [route, accountId, subjects, time],
  );
  const input = { accountId, kind: 'entry' as const, after: null, limit: 100, stepKey: randomUUID() };
  const [result, concurrent] = await Promise.all([
    purgeAccountFactsPage({ pool }, input),
    purgeAccountFactsPage({ pool }, input),
  ]);
  expect(result.value).toEqual({ examined: 100, removed: 100, after: { id: subjects[99]! }, exhausted: false });
  expect(concurrent.value).toEqual(result.value);
  expect(concurrent.transactionId).toBe(result.transactionId);
  expect([result.replayed, concurrent.replayed].sort()).toEqual([false, true]);
  expect(
    (await pool.query('SELECT subject_id FROM library.entry WHERE route=$1 AND account_id=$2', [route, accountId]))
      .rows,
  ).toEqual([{ subject_id: subjects[100] }]);
  const events = await pool.query(
    'SELECT type,subject,data FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq',
    [result.partition, result.position.toString()],
  );
  expect(events.rows).toHaveLength(101);
  expect(events.rows.slice(0, 100)).toEqual(
    subjects.slice(0, 100).map((subjectId) => ({
      type: 'com.rezics.library.entry.deleted.v1',
      subject: accountId,
      data: { subjectId },
    })),
  );
  for (const change of [{ limit: 99 }, { kind: 'follow' as const }, { after: result.value.after }])
    await expect(purgeAccountFactsPage({ pool }, { ...input, ...change })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  expect(
    (
      await pool.query('SELECT transaction_id FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2', [
        partitionOf(route),
        result.transactionId,
      ])
    ).rows,
  ).toEqual([]);
  const next = await purgeAccountFactsPage({ pool }, { ...input, after: result.value.after, stepKey: randomUUID() });
  expect(next.value).toEqual({ examined: 1, removed: 1, after: { id: subjects[100]! }, exhausted: true });
  // Deliberately inconsistent raw fixture proves the guard precedes even receipt replay.
  await pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [route, accountId]);
  await expect(purgeAccountFactsPage({ pool }, input)).rejects.toBeInstanceOf(AccountFactPurgeDeniedError);
});

test('invalid input and malformed internal cursors fail before checking out a connection', async () => {
  const accountId = newId(route);
  const input = { accountId, kind: 'entry' as const, after: null, limit: 1, stepKey: randomUUID() };
  const changes = [
    { accountId: randomUUID() },
    { kind: 'unknown' },
    { limit: 0 },
    { limit: 1.5 },
    { limit: 101 },
    { stepKey: '' },
    { stepKey: 'x'.repeat(256) },
    { after: {} },
    { after: { id: 'bad' } },
    { after: { id: accountId, createdAt: time } },
    { kind: 'copy', after: { id: accountId } },
    { kind: 'copy', after: { id: accountId, createdAt: '2026-02-30T00:00:00Z' } },
    { kind: 'copy', after: { id: accountId, createdAt: '0000-01-01T00:00:00Z' } },
    { kind: 'copy', after: { id: accountId, createdAt: 'infinity' } },
    { kind: 'copy', after: { id: accountId, createdAt: time, extra: true } },
  ];
  const unopened = new pg.Pool({ connectionString: 'postgres://invalid@127.0.0.1:1/invalid' });
  try {
    for (const change of changes) {
      await expect(
        purgeAccountFactsPage({ pool: unopened }, { ...input, ...change } as Parameters<
          typeof purgeAccountFactsPage
        >[1]),
      ).rejects.toBeDefined();
      expect(unopened.totalCount).toBe(0);
    }
  } finally {
    await unopened.end();
  }
});

test('page event schema is closed and restricts kind and integer bounds', () => {
  const validator = lookupEventType('com.rezics.library.account-facts.purged.v1')!;
  const data = { accountId: newId(route), kind: 'follow', examined: 100, removed: 0 };
  expect(validator.Check(data)).toBe(true);
  for (const change of [{ kind: 'labels' }, { examined: 101 }, { removed: -1 }, { removed: 0.5 }, { note: 'private' }])
    expect(validator.Check({ ...data, ...change })).toBe(false);
});
