import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import '../support/fixture-event-types.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import type { AuthoritativeTime } from '../../src/command/command.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
let single: pg.Pool;
beforeAll(async () => {
  db = await openGrowthDatabase();
  single = new pg.Pool({ ...db.pool.options, max: 1 });
});
afterAll(async () => {
  await single?.end();
  await db?.close();
});
test('read-only Library preparation uses native attempt T before owner checkout and cannot invalidate an authorized stored receipt', async () => {
  const route = 0x6c53,
    accountId = newId(route);
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)",
    [route, accountId],
  );
  const actor = {
    kind: 'account' as const,
    accountId,
    clientId: 'prepared-owner-test',
    scopes: ['copy:create'],
    authnEpoch: 1,
    requestedBy: null,
  };
  const runner = createLibraryCommandRunner({ pool: single });
  let allow = true,
    bodies = 0,
    preparations = 0;
  let time: AuthoritativeTime | undefined;
  const base = {
    action: 'copy:create',
    kind: 'library.fixture.prepared',
    requestKey: crypto.randomUUID(),
    input: { subjectId: newId(route), value: 'one' },
  };
  const request = (requestKey = base.requestKey) => ({
    ...base,
    requestKey,
    prepare: async (attempt: { time: AuthoritativeTime }) => {
      preparations++;
      time = attempt.time;
      expect(attempt.time).toBeDefined();
      expect((await single.query('SELECT 1 AS ready')).rows[0]!.ready).toBe(1);
      return { problem: allow ? null : new Error('profile no longer supported'), value: 'one' };
    },
  });
  const body = async (
    _tx: unknown,
    context: { time: AuthoritativeTime },
    prepared: { problem: Error | null; value: string },
  ) => {
    if (time === undefined) throw new Error('Expected preparation to capture the native attempt time');
    expect(context.time).toBe(time);
    if (prepared.problem) throw prepared.problem;
    bodies++;
    return { value: prepared.value, events: [{ type: 'com.rezics.fixture.created.v1', data: {} }] };
  };
  const first = await runner.ownAccountPrepared(actor, request(), body);
  expect(first.value).toBe('one');
  expect(first.replayed).toBe(false);
  allow = false;
  const replay = await runner.ownAccountPrepared(actor, request(), body);
  expect(replay.value).toBe(first.value);
  expect(replay.replayed).toBe(true);
  expect(bodies).toBe(1);
  expect(preparations).toBe(2);
  await expect(runner.ownAccountPrepared(actor, request(crypto.randomUUID()), body)).rejects.toThrow(
    'profile no longer supported',
  );
  expect(bodies).toBe(1);
  const receipts = await db.admin.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM core.receipt WHERE partition_no=$1 AND command_kind=$2',
    [partitionOf(route), base.kind],
  );
  expect(receipts.rows[0]!.count).toBe(1);
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    route,
    accountId,
  ]);
  await expect(runner.ownAccountPrepared(actor, request(), body)).rejects.toBeInstanceOf(GrantDeniedError);
  expect(bodies).toBe(1);
});
