import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { MAX_COMMAND_EVENTS, runCommand, TooManyEventsError, type CommandEvent } from '../src/command/command.ts';
import { createPool } from '../src/database/pool.ts';
import { problemResponse } from '../src/http/problem.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const partition = 12;
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
let growth: GrowthDatabase | undefined;

beforeAll(async () => {
  growth = await openGrowthDatabase(databaseUrl);
});

afterEach(async () => {
  await admin.query("UPDATE core.partition SET write_state = 'active', moved_to = NULL, position = 0 WHERE partition_no = $1", [partition]);
  await admin.query('DELETE FROM core.receipt WHERE partition_no = $1', [partition]);
  await admin.query('DELETE FROM editorial.write_basis WHERE partition_no = $1', [partition]);
  await admin.query('DELETE FROM core.outbox WHERE partition_no = $1', [partition]);
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
  await growth?.close();
});

const event = (n: number): CommandEvent => ({ type: 'com.rezics.test.happened.v1', subject: `s${n}`, data: { n } });
const events = (count: number): CommandEvent[] => Array.from({ length: count }, (_, n) => event(n));

test('a command with 1,001 events fails before commit and leaves no position, events or receipt', async () => {
  const actorAccountId = '10000000-0000-4000-8000-000000000001';
  const error = await runCommand(
    pool,
    {
      partition,
      basis: { actorAccountId, clientId: 'test', requestedBy: null },
      receipt: { actorAccountId, kind: 'test.command', key: 'oversized', digest: new Uint8Array(32) },
    },
    async () => ({ value: { accepted: true }, events: events(MAX_COMMAND_EVENTS + 1) }),
  ).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(TooManyEventsError);
  expect(error).toMatchObject({ partition, count: MAX_COMMAND_EVENTS + 1 });
  expect(await admin.query('SELECT position::int FROM core.partition WHERE partition_no = $1', [partition])).toMatchObject({
    rows: [{ position: 0 }],
  });
  expect(await admin.query('SELECT count(*)::int AS n FROM core.outbox WHERE partition_no = $1', [partition])).toMatchObject({
    rows: [{ n: 0 }],
  });
  expect(await admin.query('SELECT count(*)::int AS n FROM editorial.write_basis WHERE partition_no = $1', [partition])).toMatchObject({
    rows: [{ n: 0 }],
  });
  expect(await admin.query('SELECT count(*)::int AS n FROM core.receipt WHERE partition_no = $1', [partition])).toMatchObject({
    rows: [{ n: 0 }],
  });
});

test('a command with 1,000 events commits', async () => {
  const result = await runCommand(pool, { partition }, async () => ({ value: 'committed', events: events(MAX_COMMAND_EVENTS) }));
  expect(result).toMatchObject({ value: 'committed', partition, position: 1n, replayed: false });
  expect(await admin.query('SELECT count(*)::int AS n FROM core.outbox WHERE partition_no = $1', [partition])).toMatchObject({
    rows: [{ n: MAX_COMMAND_EVENTS }],
  });
});

test('too many events maps to the too_many_events problem', async () => {
  const error = new TooManyEventsError(partition, MAX_COMMAND_EVENTS + 1);
  const response = problemResponse(error, { method: 'POST', id: 'request-1' });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    type: 'https://rezics.com/problems/too_many_events',
    title: 'Too Many Events',
    status: 422,
    code: 'too_many_events',
    retryable: false,
    detail: expect.stringContaining(String(MAX_COMMAND_EVENTS)),
  });
});

test('New command stays within its bound as k grows', async () => {
  const database = growth!;
  await database.admin.query("UPDATE core.partition SET write_state = 'active', moved_to = NULL, position = 0 WHERE partition_no = $1", [partition]);
  await database.admin.query('DELETE FROM core.receipt WHERE partition_no = $1', [partition]);
  await database.admin.query('DELETE FROM editorial.write_basis WHERE partition_no = $1', [partition]);
  await database.admin.query('DELETE FROM core.outbox WHERE partition_no = $1', [partition]);
  await checkGrowth(database, {
    name: 'New command stays within its bound as k grows',
    scales: [1, 8, 64],
    repetitions: 1,
    warmups: 0,
    bounds: { rows: 'linear', blocks: 'linear', statements: 'constant' },
    grow: async () => {},
    operation: async (db, count) =>
      runCommand(db.pool, { partition }, async () => ({ value: null, events: events(count) })),
  });
});
