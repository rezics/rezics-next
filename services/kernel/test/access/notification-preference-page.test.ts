import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { DEFAULT_NOTIFICATIONS, NOTIFICATION_KINDS, type Notifications } from '../../src/access/notification-kinds.ts';
import { projectPreferencePage } from '../../src/access/preferences.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
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
    routeKey: new Uint8Array(32).fill(31),
    tokens: fixture.referenceKeys,
    receiptKeys: testReceiptKeys(),
    access: () => fixture.access,
    writeRate: createWriteRateLimiter({ secret: 'preference-page-write-rate-secret-32bytes' }),
  });
}, 120000);
afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    await db?.close();
  }
});

async function call(person: { accountId: string; bearer: string }, body?: unknown, key = Bun.randomUUIDv7()) {
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${person.accountId}/preferences`, {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: {
        authorization: `Bearer ${person.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, value: await response.json() };
}

const pageOf = (notifications: Notifications, version: number, writable = true) =>
  projectPreferencePage({ notifications, version }, { writable });

test('GET and PATCH 200 carry the catalogue page, compulsory policy and admitted edit/reset actions', async () => {
  const person = await fixture.person('preference-page-read');
  const read = await call(person);
  expect(read.status).toBe(200);
  expect(read.value.viewerState).toBe('current');
  expect(read.value.allowedActions).toEqual({ read: { allowed: true }, update: { allowed: true } });
  expect(read.value.reading.effective).toEqual({ spoilerLevel: 0, suitability: 'blur' });
  expect(read.value.notifications).toEqual(DEFAULT_NOTIFICATIONS);
  expect(read.value.page).toEqual(pageOf(DEFAULT_NOTIFICATIONS, 0));
  expect(read.value.page.kinds).toEqual(
    NOTIFICATION_KINDS.map((entry) => ({
      kind: entry.kind,
      optional: entry.optional,
      default: entry.default,
      enabled: true,
    })),
  );
  expect(read.value.page.kinds.some((entry: { kind: string }) => entry.kind === 'moderation_decision')).toBe(true);
  expect(read.value.page.actions).toEqual([
    { name: 'edit', expectedVersion: 0 },
    { name: 'reset', expectedVersion: 0 },
  ]);
  const changed = await call(person, { expectedVersion: 0, notifications: { reply: false } });
  expect(changed.status).toBe(200);
  expect(changed.value.allowedActions.update).toEqual({ allowed: true });
  expect(changed.value.page).toEqual(pageOf({ ...DEFAULT_NOTIFICATIONS, reply: false }, 1));
  expect(changed.value.page.actions.every((action: { expectedVersion: number }) => action.expectedVersion === 1)).toBe(
    true,
  );
  expect(changed.value.page.kinds.find((entry: { kind: string }) => entry.kind === 'moderation_decision')).toEqual({
    kind: 'moderation_decision',
    optional: false,
    default: true,
    enabled: true,
  });
});

test('unknown and compulsory patches stay 400, and 409 returns the current page for review', async () => {
  const person = await fixture.person('preference-page-conflict');
  for (const notifications of [{ moderation_decision: false }, { unknown: true }, { reply: false, unknown: false }]) {
    const refused = await call(person, { expectedVersion: 0, notifications });
    expect(refused.status).toBe(400);
    expect(refused.value.page).toBeUndefined();
  }
  expect((await call(person)).value.page).toEqual(pageOf(DEFAULT_NOTIFICATIONS, 0));
  expect((await call(person, { expectedVersion: 0, notifications: { mention: false } })).status).toBe(200);
  const conflict = await call(person, { expectedVersion: 0, notifications: { reply: false } });
  expect(conflict.status).toBe(409);
  expect(conflict.value.code).toBe('conflict');
  expect(conflict.value.viewerState).toBeUndefined();
  expect(conflict.value.allowedActions).toBeUndefined();
  expect(conflict.value.page).toEqual(pageOf({ ...DEFAULT_NOTIFICATIONS, mention: false }, 1));
  expect(conflict.value.page.actions).toEqual([
    { name: 'edit', expectedVersion: 1 },
    { name: 'reset', expectedVersion: 1 },
  ]);
});

test('read access keeps values visible without edit advice and update is checked before replay receipts', async () => {
  const person = await fixture.person('preference-page-read-only');
  const body = { expectedVersion: 0, notifications: { reply: false } };
  const key = '123e4567-e89b-42d3-a456-426614174000';
  expect((await call(person, body, key)).status).toBe(200);

  const authorize = fixture.access.authorize;
  fixture.access.authorize = async (client, actor, action, resource, evidence, time) =>
    action === 'account:update'
      ? false
      : authorize.call(fixture.access, client, actor, action, resource, evidence, time);
  try {
    const read = await call(person);
    expect(read.status).toBe(200);
    expect(read.value.viewerState).toBe('current');
    expect(read.value.allowedActions.update).toEqual({ allowed: false, reason: 'not_authorized' });
    expect(read.value.notifications).toEqual({ ...DEFAULT_NOTIFICATIONS, reply: false });
    expect(read.value.page).toEqual(pageOf({ ...DEFAULT_NOTIFICATIONS, reply: false }, 1, false));
    expect((await call(person, body, key)).status).toBe(403);
  } finally {
    fixture.access.authorize = authorize;
  }
});
