import { afterAll, beforeAll, expect, test } from 'bun:test';
import '../support/fixture-event-types.ts';
import { newId } from '../../src/route/route.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('every own-account library command holds its owner through the deletion barrier and reauthorizes replay', async () => {
  const route = 0x6a10,
    accountId = newId(route),
    runner = createLibraryCommandRunner({ pool: db.pool }),
    actor = {
      kind: 'account' as const,
      accountId,
      clientId: 'owner-lock',
      scopes: ['copy:create'],
      authnEpoch: 1,
      requestedBy: null,
    };
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)",
    [route, accountId],
  );
  let entered!: () => void,
    release!: () => void,
    calls = 0;
  const inside = new Promise<void>((r) => (entered = r)),
    resume = new Promise<void>((r) => (release = r));
  const request = {
    action: 'copy:create',
    kind: 'library.fixture.owner-share',
    requestKey: crypto.randomUUID(),
    input: {},
  };
  const write = () =>
    runner.ownAccount(actor, request, async () => {
      calls++;
      entered();
      await resume;
      return { value: 'ok', events: [{ type: 'com.rezics.fixture.created.v1', data: {} }] };
    });
  const pending = write();
  await inside;
  const barrier = await db.admin.connect();
  try {
    await barrier.query('BEGIN');
    await barrier.query("SET LOCAL lock_timeout='50ms'");
    await expect(
      barrier.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [route, accountId]),
    ).rejects.toMatchObject({ code: '55P03' });
    await barrier.query('ROLLBACK');
  } finally {
    barrier.release();
    release();
  }
  expect((await pending).value).toBe('ok');
  await db.admin.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [
    route,
    accountId,
  ]);
  await expect(write()).rejects.toThrow();
  expect(calls).toBe(1);
});
