import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { IdempotencyConflictError, runCommand, type CommandEvent } from '../src/command/command.ts';
import { createPool } from '../src/database/pool.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const actor = '019a1b2c-3d4e-7f00-8a00-beef00000001';
const event: CommandEvent = { type: 'com.rezics.test.happened.v1', data: {} };
const digest = (text: string) => createHash('sha256').update(text).digest();
async function position(partition: number): Promise<bigint> {
  const { rows } = await admin.query('SELECT position FROM core.partition WHERE partition_no = $1', [partition]);
  return BigInt(rows[0].position);
}
async function envelopes(partition: number): Promise<number> {
  const { rows } = await admin.query(
    'SELECT count(DISTINCT position)::int AS n FROM core.outbox WHERE partition_no = $1',
    [partition],
  );
  return rows[0].n;
}

test('a receipt replays the committed outcome without running the command again', async () => {
  const receipt = { actorAccountId: actor, kind: 'test.create', key: randomUUID(), digest: digest('one') };
  let runs = 0;
  const body = async () => {
    runs++;
    return { value: { created: runs, label: '書' }, events: [event] };
  };
  const first = await runCommand(pool, { partition: 20, receipt }, body);
  expect(first).toMatchObject({ value: { created: 1, label: '書' }, partition: 20, epoch: 1, replayed: false });
  const before = await position(20);
  expect(first.position).toBe(before);
  const again = await runCommand(pool, { partition: 20, receipt: { ...receipt, digest: digest('one') } }, body);
  expect(again).toEqual({ ...first, replayed: true });
  expect(runs).toBe(1);
  expect(await position(20)).toBe(before);
});

test('a reused key with a different request is refused and writes nothing', async () => {
  const receipt = { actorAccountId: actor, kind: 'test.create', key: randomUUID(), digest: digest('two') };
  await runCommand(pool, { partition: 21, receipt }, async () => ({ value: 1, events: [event] }));
  const before = await position(21);
  let ran = false;
  const error = await runCommand(
    pool,
    { partition: 21, receipt: { ...receipt, digest: digest('changed') } },
    async () => {
      ran = true;
      return { value: 2, events: [event] };
    },
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(IdempotencyConflictError);
  expect(error).toMatchObject({ name: 'IdempotencyConflictError', partition: 21 });
  expect(ran).toBe(false);
  expect(await position(21)).toBe(before);
  const otherKind = await runCommand(
    pool,
    { partition: 21, receipt: { ...receipt, kind: 'test.other' } },
    async () => ({
      value: 3,
      events: [event],
    }),
  );
  expect(otherKind).toMatchObject({ value: 3, replayed: false });
});

test('concurrent duplicates commit once and the other replays it', async () => {
  const receipt = { actorAccountId: actor, kind: 'test.create', key: randomUUID(), digest: digest('three') };
  const before = await envelopes(22);
  const body = async (tx: { query: (sql: string) => Promise<unknown> }) => {
    await tx.query('SELECT pg_sleep(0.05)');
    return { value: { at: Date.now() }, events: [event] };
  };
  const results = await Promise.all([
    runCommand(pool, { partition: 22, receipt }, body),
    runCommand(pool, { partition: 22, receipt }, body),
  ]);
  expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
  expect(results[1]!.value).toEqual(results[0]!.value);
  expect(results[1]!.transactionId).toBe(results[0]!.transactionId);
  expect(results[1]!.position).toBe(results[0]!.position);
  expect(await envelopes(22)).toBe(before + 1);
});

test('the write basis records who wrote the command, at which position, under its transaction id', async () => {
  const basis = { actorAccountId: actor, clientId: 'web', requestedBy: `urn:rezics:request:${actor}:${randomUUID()}` };
  let seen = '';
  const written = await runCommand(pool, { partition: 23, basis }, async (_tx, context) => {
    seen = context.transactionId;
    return { value: null, events: [event] };
  });
  expect(written.transactionId).toBe(seen);
  expect(written.transactionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const { rows } = await admin.query(
    `SELECT transaction_id, epoch, position, actor_account_id, client_id, requested_by, recorded_at IS NOT NULL AS dated
     FROM editorial.write_basis WHERE partition_no = 23 AND transaction_id = $1`,
    [written.transactionId],
  );
  expect(rows).toEqual([
    {
      transaction_id: written.transactionId,
      epoch: 1,
      position: String(written.position),
      actor_account_id: actor,
      client_id: 'web',
      requested_by: basis.requestedBy,
      dated: true,
    },
  ]);
  const unrecorded = await runCommand(pool, { partition: 23 }, async () => ({ value: null, events: [event] }));
  const { rows: none } = await admin.query(
    'SELECT 1 FROM editorial.write_basis WHERE partition_no = 23 AND position = $1',
    [String(unrecorded.position)],
  );
  expect(none).toEqual([]);
  expect(unrecorded.replayed).toBe(false);
});
