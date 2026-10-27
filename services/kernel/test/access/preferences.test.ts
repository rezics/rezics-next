import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { cookies, nativeFixture, scopes } from './native-account-bindings-fixture.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: ReturnType<typeof createKernel>;
let owner: Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['person']>>;
let other: typeof owner;
const routeKey = new Uint8Array(32).fill(29);
const limiter = (maximum = 10000) =>
  createWriteRateLimiter({
    secret: 'preferences-write-rate-secret-32bytes',
    overrides: JSON.stringify({ 'new-account': { write: { maximum, seconds: 86400 } } }),
  });

async function call(accountId: string, bearer?: string, body?: unknown, key = Bun.randomUUIDv7(), app = kernel) {
  const response = await app.handle(
    new Request(`http://kernel.test/v1/accounts/${accountId}/preferences`, {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, value: await response.json() };
}

beforeAll(async () => {
  scopes.push('account:read', 'account:update');
  db = await openGrowthDatabase();
  fixture = await nativeFixture(db.pool);
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens: fixture.referenceKeys,
    access: () => fixture.access,
    writeRate: limiter(),
  });
  owner = await fixture.person('preferences-owner');
  other = await fixture.person('preferences-other');
}, 120000);

afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    await db?.close();
  }
});

test('defaults require no preference row, and unchanged writes keep version zero', async () => {
  const read = await call(owner.accountId, owner.bearer);
  expect(read.response.status).toBe(200);
  expect(read.value).toEqual({
    spoilerLevel: 0,
    suitability: 'blur',
    shelf: {},
    notifications: { reply: true, mention: true },
    version: 0,
  });
  const same = await call(owner.accountId, owner.bearer, { expectedVersion: 0, spoilerLevel: 0, suitability: 'blur' });
  expect(same.response.status).toBe(200);
  expect(same.value).toEqual(read.value);
  expect(
    (
      await db.admin.query('SELECT * FROM access.account_preferences WHERE route=$1 AND account_id=$2', [
        routeOf(owner.accountId),
        owner.accountId,
      ])
    ).rows,
  ).toHaveLength(0);
});

test('versioned partial writes replay once, reject stale versions and bind the idempotency key', async () => {
  const key = Bun.randomUUIDv7();
  const body = { expectedVersion: 0, spoilerLevel: 2 };
  const first = await call(owner.accountId, owner.bearer, body, key);
  expect(first.response.status).toBe(200);
  expect(first.value).toEqual({
    spoilerLevel: 2,
    suitability: 'blur',
    shelf: {},
    notifications: { reply: true, mention: true },
    version: 1,
  });
  expect(first.response.headers.has('rezics-session-token')).toBe(true);
  expect((await call(owner.accountId, owner.bearer, body, key)).value).toEqual(first.value);
  expect(
    (
      await db.admin.query(
        "SELECT 1 FROM core.receipt WHERE command_kind='access.account.preferences' AND idempotency_key=$1",
        [key],
      )
    ).rows,
  ).toHaveLength(1);
  expect((await call(owner.accountId, owner.bearer, { ...body, spoilerLevel: 1 }, key)).response.status).toBe(422);
  expect((await call(owner.accountId, owner.bearer, { expectedVersion: 0, suitability: 'show' })).response.status).toBe(
    409,
  );
  expect((await call(owner.accountId, owner.bearer, { expectedVersion: 1, suitability: 'show' })).value).toEqual({
    spoilerLevel: 2,
    suitability: 'show',
    shelf: {},
    notifications: { reply: true, mention: true },
    version: 2,
  });
  const unchanged = await call(owner.accountId, owner.bearer, { expectedVersion: 2, suitability: 'show' });
  expect(unchanged.value).toEqual({
    spoilerLevel: 2,
    suitability: 'show',
    shelf: {},
    notifications: { reply: true, mention: true },
    version: 2,
  });
  const stored = await db.admin.query(
    'SELECT count(*)::int AS count FROM access.account_preferences WHERE account_id=$1',
    [owner.accountId],
  );
  expect(stored.rows[0].count).toBe(1);
  expect((await call(owner.accountId, owner.bearer)).value).toEqual(unchanged.value);
});

test('another account and anonymous callers cannot read or set preferences', async () => {
  for (const body of [undefined, { expectedVersion: 0, spoilerLevel: 1 }]) {
    expect((await call(owner.accountId, other.bearer, body)).response.status).toBe(403);
    expect((await call(owner.accountId, undefined, body)).response.status).toBe(401);
  }
});

test('invalid values and unknown properties are refused', async () => {
  for (const body of [
    { expectedVersion: 0, spoilerLevel: -1 },
    { expectedVersion: 0, spoilerLevel: 3 },
    { expectedVersion: 0, spoilerLevel: 1.5 },
    { expectedVersion: 0, spoilerLevel: '1' },
    { expectedVersion: 0, suitability: 'hide' },
    { expectedVersion: 0, suitability: null },
    { expectedVersion: -1 },
    { expectedVersion: 0.5 },
    { spoilerLevel: 1 },
    { expectedVersion: 0, accountId: owner.accountId },
  ])
    expect((await call(other.accountId, other.bearer, body)).response.status).toBe(400);
});

test('an operator-opened session reads and sets its automated account only', async () => {
  const bot = await fixture.automated('preferences-bot', owner);
  const operationKey = 'preferences-opening';
  const operation = {
    kind: 'opening' as const,
    operatorAccountId: owner.accountId,
    subjectAccountId: bot.accountId,
    authorization: 'approval-request',
  };
  const approval = await fixture
    .approval()
    .approve(owner.bearer, { operationKey, operation }, { pool: db.pool, deadline: Date.now() + 10000 });
  const opened = await fixture.host.workflows.openOperatorSession({
    key: operationKey,
    authorization: approval.reference,
    operatorAccountId: owner.accountId,
    subjectAccountId: bot.accountId,
    headers: owner.headers,
  });
  expect(opened.status).toBe(200);
  const token = await fixture.request('/token', {}, cookies(opened));
  const { access_token: bearer } = (await token.json()) as { access_token: string };
  expect((await call(bot.accountId, bearer)).value).toEqual({
    spoilerLevel: 0,
    suitability: 'blur',
    shelf: {},
    notifications: { reply: true, mention: true },
    version: 0,
  });
  const result = await call(bot.accountId, bearer, { expectedVersion: 0, suitability: 'show', spoilerLevel: 1 });
  expect(result.response.status).toBe(200);
  expect(result.value).toEqual({
    spoilerLevel: 1,
    suitability: 'show',
    shelf: {},
    notifications: { reply: true, mention: true },
    version: 1,
  });
  expect((await call(owner.accountId, bearer)).response.status).toBe(403);
  expect((await call(bot.accountId, owner.bearer, { expectedVersion: 1, spoilerLevel: 2 })).response.status).toBe(403);
});

test('PATCH passes through write-rate admission before a preference or receipt write', async () => {
  const limited = createKernel({
    pool: db.pool,
    routeKey,
    tokens: fixture.referenceKeys,
    access: () => fixture.access,
    writeRate: limiter(1),
  });
  const person = await fixture.person('preferences-limited');
  const first = await call(
    person.accountId,
    person.bearer,
    { expectedVersion: 0, spoilerLevel: 1 },
    Bun.randomUUIDv7(),
    limited,
  );
  expect(first.response.status).toBe(200);
  const deniedKey = Bun.randomUUIDv7();
  const denied = await call(
    person.accountId,
    person.bearer,
    { expectedVersion: 1, suitability: 'show' },
    deniedKey,
    limited,
  );
  expect(denied.response.status).toBe(429);
  expect((await call(person.accountId, person.bearer)).value).toEqual({
    spoilerLevel: 1,
    suitability: 'blur',
    shelf: {},
    notifications: { reply: true, mention: true },
    version: 1,
  });
  expect((await db.admin.query('SELECT 1 FROM core.receipt WHERE idempotency_key=$1', [deniedKey])).rows).toHaveLength(
    0,
  );
});

test('concurrent first writes compare the same expected version without losing an update', async () => {
  const person = await fixture.person('preferences-concurrent');
  const results = await Promise.all([
    call(person.accountId, person.bearer, { expectedVersion: 0, spoilerLevel: 1 }),
    call(person.accountId, person.bearer, { expectedVersion: 0, suitability: 'show' }),
  ]);
  expect(results.map(({ response }) => response.status).sort()).toEqual([200, 409]);
  const winner = results.find(({ response }) => response.status === 200)!;
  expect((await call(person.accountId, person.bearer)).value).toEqual(winner.value);
});

const shelfRow = (accountId: string) =>
  db.admin.query('SELECT shelf, version FROM access.account_preferences WHERE route=$1 AND account_id=$2', [
    routeOf(accountId),
    accountId,
  ]);

test('a shelf is empty until saved, merges by part and entry, and null removes', async () => {
  const person = await fixture.person('preferences-shelf');
  expect((await call(person.accountId, person.bearer)).value.shelf).toEqual({});
  const empty = await call(person.accountId, person.bearer, { expectedVersion: 0, shelf: {} });
  expect(empty.value).toEqual({
    spoilerLevel: 0,
    suitability: 'blur',
    shelf: {},
    notifications: { reply: true, mention: true },
    version: 0,
  });
  expect((await shelfRow(person.accountId)).rows).toHaveLength(0);
  const book = 'https://rezics.com/vocab/Book';
  const first = await call(person.accountId, person.bearer, {
    expectedVersion: 0,
    shelf: {
      layouts: { all: 'grid', [book]: 'table' },
      sorts: { all: { field: 'title', direction: 'asc' } },
      gridSize: 'large',
      tableColumns: ['title', 'cover'],
    },
  });
  expect(first.response.status).toBe(200);
  expect(first.value).toEqual({
    spoilerLevel: 0,
    suitability: 'blur',
    shelf: {
      layouts: { all: 'grid', [book]: 'table' },
      sorts: { all: { field: 'title', direction: 'asc' } },
      gridSize: 'large',
      tableColumns: ['title', 'cover'],
    },
    notifications: { reply: true, mention: true },
    version: 1,
  });
  const second = await call(person.accountId, person.bearer, {
    expectedVersion: 1,
    shelf: {
      layouts: { all: null, 'https://rezics.com/vocab/Film': 'list' },
      sorts: { planned: { field: 'added', direction: 'desc' }, all: { direction: 'desc' } },
      tableColumns: ['status'],
    },
  });
  expect(second.value.shelf).toEqual({
    layouts: { [book]: 'table', 'https://rezics.com/vocab/Film': 'list' },
    sorts: { planned: { field: 'added', direction: 'desc' }, all: { field: 'title', direction: 'desc' } },
    gridSize: 'large',
    tableColumns: ['status'],
  });
  expect(second.value.version).toBe(2);
  const removed = await call(person.accountId, person.bearer, {
    expectedVersion: 2,
    shelf: { gridSize: null, sorts: null, layouts: { [book]: null } },
  });
  expect(removed.value.shelf).toEqual({
    layouts: { 'https://rezics.com/vocab/Film': 'list' },
    tableColumns: ['status'],
  });
  expect((await call(person.accountId, person.bearer)).value).toEqual(removed.value);
  const cleared = await call(person.accountId, person.bearer, { expectedVersion: 3, shelf: null });
  expect(cleared.value).toEqual({
    spoilerLevel: 0,
    suitability: 'blur',
    shelf: {},
    notifications: { reply: true, mention: true },
    version: 4,
  });
  expect((await shelfRow(person.accountId)).rows[0].shelf).toEqual({});
});

test('a patch that leaves the shelf unchanged keeps the version and writes no row', async () => {
  const person = await fixture.person('preferences-shelf-same');
  const shelf = { gridSize: 'small', layouts: { all: 'list' } };
  expect((await call(person.accountId, person.bearer, { expectedVersion: 0, shelf })).value.version).toBe(1);
  for (const patch of [shelf, { gridSize: 'small' }, { sorts: null }, { layouts: { 'urn:x:none': null } }, {}]) {
    const same = await call(person.accountId, person.bearer, { expectedVersion: 1, shelf: patch });
    expect(same.response.status).toBe(200);
    expect(same.value.version).toBe(1);
  }
  expect((await shelfRow(person.accountId)).rows[0].version).toBe(1);
});

test('shelf values outside the allowed shape or bounds are refused and change nothing', async () => {
  const person = await fixture.person('preferences-shelf-invalid');
  const saved = await call(person.accountId, person.bearer, {
    expectedVersion: 0,
    shelf: { gridSize: 'medium', sorts: { all: { field: 'title', direction: 'asc' } } },
  });
  expect(saved.response.status).toBe(200);
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`https://x.test/t${index}`, 'grid']));
  const bad: unknown[] = [
    { layouts: { all: 'cards' } },
    { layouts: { Book: 'grid' } },
    { layouts: { 'https://x.test/a b': 'grid' } },
    { layouts: { [`https://x.test/${'a'.repeat(250)}`]: 'grid' } },
    { layouts: many },
    { layouts: [] },
    { sorts: { everything: { field: 'title', direction: 'asc' } } },
    { sorts: { planned: { field: 'title' } } },
    { sorts: { planned: { field: 'size', direction: 'asc' } } },
    { sorts: { planned: { field: 'title', direction: 'up' } } },
    { sorts: { planned: { field: 'title', direction: 'asc', extra: 1 } } },
    { sorts: { all: { field: null } } },
    { gridSize: 'huge' },
    { gridSize: 1 },
    { tableColumns: [] },
    { tableColumns: ['title', 'title'] },
    { tableColumns: ['title', 'nope'] },
    { tableColumns: 'title' },
    {
      tableColumns: [
        'cover',
        'title',
        'creator',
        'type',
        'status',
        'progress',
        'rating',
        'added',
        'started',
        'finished',
        'last_activity',
        'cover',
      ],
    },
    { unknown: 1 },
    { unknown: null },
    'grid',
    [],
  ];
  for (const shelf of bad) {
    const refused = await call(person.accountId, person.bearer, { expectedVersion: 1, shelf });
    expect([shelf, refused.response.status]).toEqual([shelf, 400]);
  }
  const layouts32 = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`https://x.test/t${index}`, 'grid']));
  expect(
    (await call(person.accountId, person.bearer, { expectedVersion: 1, shelf: { layouts: layouts32 } })).value.version,
  ).toBe(2);
  expect(
    (
      await call(person.accountId, person.bearer, {
        expectedVersion: 2,
        shelf: { layouts: { 'https://x.test/extra': 'list' } },
      })
    ).response.status,
  ).toBe(400);
  expect(
    (
      await call(person.accountId, person.bearer, {
        expectedVersion: 2,
        shelf: { layouts: { 'https://x.test/t0': null, 'https://x.test/extra': 'list' } },
      })
    ).response.status,
  ).toBe(200);
  const stored = (await shelfRow(person.accountId)).rows[0];
  expect(stored.version).toBe(3);
  expect(Object.keys(stored.shelf.layouts)).toHaveLength(32);
});

test('another account cannot read or set a shelf, and an operator-opened session sets its automated account', async () => {
  const patch = { expectedVersion: 0, shelf: { gridSize: 'small' } };
  expect((await call(owner.accountId, other.bearer, patch)).response.status).toBe(403);
  expect((await call(owner.accountId, undefined, patch)).response.status).toBe(401);
  const bot = await fixture.automated('preferences-shelf-bot', other);
  const operationKey = 'preferences-shelf-opening';
  const operation = {
    kind: 'opening' as const,
    operatorAccountId: other.accountId,
    subjectAccountId: bot.accountId,
    authorization: 'approval-request',
  };
  const approval = await fixture
    .approval()
    .approve(other.bearer, { operationKey, operation }, { pool: db.pool, deadline: Date.now() + 10000 });
  const opened = await fixture.host.workflows.openOperatorSession({
    key: operationKey,
    authorization: approval.reference,
    operatorAccountId: other.accountId,
    subjectAccountId: bot.accountId,
    headers: other.headers,
  });
  expect(opened.status).toBe(200);
  const token = await fixture.request('/token', {}, cookies(opened));
  const { access_token: bearer } = (await token.json()) as { access_token: string };
  const result = await call(bot.accountId, bearer, patch);
  expect(result.response.status).toBe(200);
  expect(result.value.shelf).toEqual({ gridSize: 'small' });
  expect((await call(bot.accountId, other.bearer)).response.status).toBe(403);
});
