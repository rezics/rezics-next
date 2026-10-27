import { afterAll, beforeAll, expect, test } from 'bun:test';
import { clientDeclarations, committedDeclarations } from '../../scripts/client.ts';
import { notificationAllowed } from '../../src/access/index.ts';
import { createPreferenceCommands } from '../../src/access/preferences.ts';
import {
  DEFAULT_NOTIFICATIONS,
  NOTIFICATION_KINDS,
  type NotificationsPatch,
} from '../../src/access/notification-kinds.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { nativeFixture, scopes } from './native-account-bindings-fixture.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: ReturnType<typeof createKernel>;

beforeAll(async () => {
  scopes.push('account:read', 'account:update');
  db = await openGrowthDatabase();
  fixture = await nativeFixture(db.pool);
  kernel = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(30),
    tokens: fixture.referenceKeys,
    access: () => fixture.access,
    writeRate: createWriteRateLimiter({ secret: 'notifications-write-rate-secret-32bytes' }),
  });
}, 120000);
afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    await db?.close();
  }
});

async function call(person: { accountId: string; bearer: string }, body?: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${person.accountId}/preferences`, {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: {
        authorization: `Bearer ${person.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, value: await response.json() };
}
const stored = (accountId: string) =>
  db.admin.query(
    'SELECT notifications, version, xmin::text FROM access.account_preferences WHERE route=$1 AND account_id=$2',
    [routeOf(accountId), accountId],
  );
const allOff = Object.fromEntries(
  NOTIFICATION_KINDS.filter(({ optional }) => optional).map(({ kind }) => [kind, false]),
);

test('preferences return every optional notification kind as enabled until the account turns one off and no default is stored', async () => {
  const person = await fixture.person('notifications-defaults');
  expect(Object.isFrozen(NOTIFICATION_KINDS)).toBe(true);
  expect(NOTIFICATION_KINDS.every(Object.isFrozen)).toBe(true);
  const read = await call(person);
  expect(read.status).toBe(200);
  expect(read.value.notifications).toEqual(DEFAULT_NOTIFICATIONS);
  expect(Object.values(read.value.notifications).every((value) => value === true)).toBe(true);
  expect((await stored(person.accountId)).rows).toHaveLength(0);
  const changed = await call(person, { expectedVersion: 0, notifications: { reply: false, mention: true } });
  expect(changed.status).toBe(200);
  expect(changed.value.notifications).toEqual({ ...DEFAULT_NOTIFICATIONS, reply: false });
  expect((await stored(person.accountId)).rows[0].notifications).toEqual({ reply: false });
  expect((await call(person)).value).toEqual(changed.value);
});

test("a notifications patch merges per kind and null restores a kind's default", async () => {
  const person = await fixture.person('notifications-merge');
  expect((await call(person, { expectedVersion: 0, notifications: { reply: false } })).status).toBe(200);
  const merged = await call(person, {
    expectedVersion: 1,
    notifications: { mention: false },
    shelf: { gridSize: 'large' },
  });
  expect(merged.status).toBe(200);
  expect(merged.value.notifications).toEqual(allOff);
  expect(merged.value.version).toBe(2);
  const restored = await call(person, { expectedVersion: 2, notifications: { reply: null } });
  expect(restored.status).toBe(200);
  expect(restored.value.notifications).toEqual({ ...DEFAULT_NOTIFICATIONS, mention: false });
  expect((await stored(person.accountId)).rows[0].notifications).toEqual({ mention: false });
  const cleared = await call(person, { expectedVersion: 3, notifications: null });
  expect(cleared.status).toBe(200);
  expect(cleared.value.notifications).toEqual(DEFAULT_NOTIFICATIONS);
  expect(cleared.value.shelf).toEqual({ gridSize: 'large' });
  expect(cleared.value.version).toBe(4);
  expect((await stored(person.accountId)).rows[0].notifications).toEqual({});
});

test('a mandatory or unknown kind in a patch is refused with 400 and changes nothing', async () => {
  const person = await fixture.person('notifications-invalid');
  for (const notifications of [
    { reply: false, moderation_decision: false },
    { moderation_decision: true },
    { moderation_decision: null },
    { reply: false, unknown: true },
    { unknown: null },
    { reply: 1 },
    { reply: 'false' },
    { reply: {} },
    { reply: [] },
    { reply: false, mention: 'true' },
    false,
    [],
    'reply',
  ]) {
    expect((await call(person, { expectedVersion: 0, notifications, suitability: 'show' })).status).toBe(400);
    expect((await stored(person.accountId)).rows).toHaveLength(0);
  }
  expect((await call(person)).value).toEqual({
    spoilerLevel: 0,
    suitability: 'blur',
    shelf: {},
    notifications: DEFAULT_NOTIFICATIONS,
    version: 0,
  });
  await call(person, { expectedVersion: 0, notifications: allOff });
  const before = (await stored(person.accountId)).rows;
  expect(
    (await call(person, { expectedVersion: 1, notifications: { reply: true, moderation_decision: null } })).status,
  ).toBe(400);
  expect((await stored(person.accountId)).rows).toEqual(before);
});

test('a patch that leaves notifications unchanged keeps the version and writes no row', async () => {
  const person = await fixture.person('notifications-noop');
  for (const notifications of [{}, DEFAULT_NOTIFICATIONS, { reply: null }, null]) {
    const unchanged = await call(person, { expectedVersion: 0, notifications });
    expect(unchanged.status).toBe(200);
    expect(unchanged.value.version).toBe(0);
    expect((await stored(person.accountId)).rows).toHaveLength(0);
  }
  await call(person, { expectedVersion: 0, notifications: allOff });
  const before = (await stored(person.accountId)).rows;
  const unchanged = await call(person, { expectedVersion: 1, notifications: allOff });
  expect(unchanged.status).toBe(200);
  expect(unchanged.value.version).toBe(1);
  expect((await stored(person.accountId)).rows).toEqual(before);
});

test('the command refuses invalid notification patches before any write', async () => {
  const person = await fixture.person('notifications-command');
  const context = { pool: db.pool, deadline: Date.now() + 10000 };
  const actor = await fixture.access.authenticate(person.bearer, context);
  const commands = createPreferenceCommands({ pool: db.pool, access: fixture.access, clock: () => new Date() });
  for (const notifications of [{ moderation_decision: false }, { unknown: true }, { reply: 1 }, []]) {
    const key = Bun.randomUUIDv7();
    await expect(
      commands.setPreferences(
        { ...context, actor },
        {
          accountId: person.accountId,
          key,
          expectedVersion: 0,
          notifications: notifications as unknown as NotificationsPatch,
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await stored(person.accountId)).rows).toHaveLength(0);
    expect((await db.admin.query('SELECT 1 FROM core.receipt WHERE idempotency_key=$1', [key])).rows).toHaveLength(0);
  }
});

test("notificationAllowed follows the recipient's setting for an optional kind", async () => {
  const person = await fixture.person('notifications-optional');
  for (const { kind, optional } of NOTIFICATION_KINDS)
    if (optional) expect(await notificationAllowed(db.pool, { recipient: person.accountId, kind })).toBe(true);
  await call(person, { expectedVersion: 0, notifications: { reply: false } });
  expect(await notificationAllowed(db.pool, { recipient: person.accountId, kind: 'reply' })).toBe(false);
  expect(await notificationAllowed(db.pool, { recipient: person.accountId, kind: 'mention' })).toBe(true);
  await call(person, { expectedVersion: 1, notifications: { reply: null } });
  expect(await notificationAllowed(db.pool, { recipient: person.accountId, kind: 'reply' })).toBe(true);
});

test('notificationAllowed is true for a mandatory kind even when the recipient turned everything off or is suspended', async () => {
  const person = await fixture.person('notifications-mandatory');
  expect((await call(person, { expectedVersion: 0, notifications: allOff })).status).toBe(200);
  expect(await notificationAllowed(db.pool, { recipient: person.accountId, kind: 'moderation_decision' })).toBe(true);
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(person.accountId),
    person.accountId,
  ]);
  expect(await notificationAllowed(db.pool, { recipient: person.accountId, kind: 'moderation_decision' })).toBe(true);
  expect(await notificationAllowed(db.pool, { recipient: person.accountId, kind: 'reply' })).toBe(false);
});

test('notificationAllowed is false for a deleted or pending recipient', async () => {
  for (const state of ['deleted', 'pending']) {
    const recipient = newId(0x456a);
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor',$3,$2)",
      [routeOf(recipient), recipient, state],
    );
    for (const { kind } of NOTIFICATION_KINDS)
      expect(await notificationAllowed(db.pool, { recipient, kind })).toBe(false);
  }
  for (const { kind } of NOTIFICATION_KINDS)
    expect(await notificationAllowed(db.pool, { recipient: newId(0x456a), kind })).toBe(false);
});

test('unknown notification kinds throw a TypeError before any read', async () => {
  let reads = 0;
  const client = {
    query: (() => {
      reads++;
      throw new Error('Unexpected read');
    }) as typeof db.pool.query,
  };
  for (const kind of ['unknown', 'toString', '__proto__', 'Reply'])
    await expect(notificationAllowed(client, { recipient: newId(0x456a), kind })).rejects.toBeInstanceOf(TypeError);
  expect(reads).toBe(0);
});

test('another account cannot read or set notification preferences', async () => {
  const owner = await fixture.person('notifications-owner');
  const other = await fixture.person('notifications-other');
  const caller = { ...owner, bearer: other.bearer };
  expect((await call(caller)).status).toBe(403);
  expect((await call(caller, { expectedVersion: 0, notifications: allOff })).status).toBe(403);
  expect((await stored(owner.accountId)).rows).toHaveLength(0);
});

// Match the existing client contract check's budget for SQL typing and declaration emission.
test('the client declarations are regenerated', () => {
  expect([...committedDeclarations()]).toEqual([...clientDeclarations()]);
}, 180000);
