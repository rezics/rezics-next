import { afterAll, expect, spyOn, test } from 'bun:test';
import { t } from 'elysia';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { customMethod } from '../../src/http/custom-method.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import { MountedRouteCatalogue } from '../../src/http/request.ts';
import { declareKernelWriteRates } from '../../src/http/write-rate-routes.ts';
import type { WriteRateFamily } from '../../src/access/write-rate.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
// Payout and offer writes sit behind the selling gate, which the platform opens explicitly.
const openSelling = () =>
  pool.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('selling', tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), $1)
     ON CONFLICT DO NOTHING`,
    [Bun.randomUUIDv7()],
  );
const post = (path: string, body: unknown = {}) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': '"mounted-probe"',
      'x-action': 'item:read',
      'x-rate-family': 'provider',
    },
    body: JSON.stringify(body),
  });
const nativeWrites = () => [
  { path: `/v1/payoutStatements/${Bun.randomUUIDv7()}:markPaid`, body: { paidReference: 'wire' } },
  { path: `/v1/offers/${Bun.randomUUIDv7()}:delist`, body: { expectedRevision: 1 } },
];
const detail = (action: string, family: WriteRateFamily = 'write') => ({
  operationId: action.replace(':', '.'),
  'x-action': action,
  'x-exposure': 'public',
  security: [{}],
  'x-rate-limit': defineRateLimit({ family, units: 1 }),
});

test('native parameterized custom methods resolve the actual mounted rate declaration', async () => {
  const spends: unknown[] = [];
  const actions: string[] = [];
  let effects = 0;
  const readDetail = { operationId: 'item.read', 'x-action': 'item:read', 'x-exposure': 'public', security: [{}] };
  const app = createApp({
    pool,
    access: {
      async authenticate() {
        throw new Error('unused');
      },
      async prepare(_actor, action) {
        actions.push(action);
      },
      async authorize() {
        return true;
      },
    },
    writeRate: {
      async spend(_context, family, units) {
        spends.push([family, units, effects]);
        return { allowed: true };
      },
    },
  })
    .post(
      customMethod('/items/:itemId', 'update'),
      { body: t.Object({ value: t.Integer() }), detail: detail('item:update', 'report') },
      async ({ authorize, params }) => {
        await authorize({ route: 0, id: params.itemId });
        return ++effects;
      },
    )
    .get(customMethod('/items/:itemId', 'update'), { detail: detail('item:read', 'search') }, () => ++effects)
    .post('/items/literal', { detail: detail('literal:create', 'upload') }, () => ++effects)
    .post(customMethod('/items/:itemId', 'inspect'), { detail: readDetail }, async ({ authorize }) => {
      await authorize({ route: 0, id: 'read' });
      return 'read';
    });
  expect((await app.handle(post('/items/one:update', { value: 'bad' }))).status).toBe(400);
  expect(spends).toEqual([]);
  for (const id of ['one', 'two'])
    expect((await app.handle(post(`/items/${id}:update`, { value: 1 }))).status).toBe(200);
  expect((await app.handle(new Request('http://localhost/items/three:update'))).status).toBe(200);
  expect((await app.handle(post('/items/literal'))).status).toBe(200);
  expect((await app.handle(post('/items/four:inspect'))).status).toBe(200);
  for (const path of ['/items/one/$update', '/items/one/%24update'])
    expect((await app.handle(post(path))).status).toBe(404);
  expect(spends).toEqual([
    ['report', 1, 0],
    ['report', 1, 1],
    ['search', 1, 2],
    ['upload', 1, 3],
  ]);
  expect(actions).toEqual(['item:update', 'item:update', 'item:read']);
  const otherSpends: unknown[] = [];
  const other = createApp({
    pool,
    writeRate: {
      async spend(_context, family, units) {
        otherSpends.push([family, units]);
        return { allowed: true };
      },
    },
  }).post(customMethod('/items/:itemId', 'update'), { detail: detail('other:update', 'correspondence') }, () => true);
  expect((await other.handle(post('/items/one:update'))).status).toBe(200);
  expect(otherSpends).toEqual([['correspondence', 1]]);
});

test('createKernel custom writes use post-mount composition declarations before any business effect', async () => {
  await openSelling();
  const spends: unknown[] = [];
  const app = createKernel({
    receiptKeys: testReceiptKeys(),
    pool,
    routeKey: new Uint8Array(32),
    writeRate: {
      async spend(_context, family, units) {
        spends.push([family, units]);
        return { allowed: false, retryAfter: 7 };
      },
    },
  });
  // Composed hook views may be recreated after the composition declaration pass.
  const declared = app.routes;
  Object.defineProperty(app, 'routes', {
    get() {
      return declared.map((route) => {
        const detail = { ...route.hooks?.detail } as Record<string, unknown>;
        delete detail['x-rate-limit'];
        return { ...route, hooks: { ...route.hooks, detail } };
      });
    },
  });
  const lookup = spyOn(MountedRouteCatalogue.prototype, 'find');
  try {
    for (const { path, body } of nativeWrites()) {
      const response = await app.handle(post(path, body));
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('7');
      expect(await response.json()).toMatchObject({ code: 'rate_limited', effect_status: 'not_applied' });
    }
    expect(spends).toEqual([
      ['write', 1],
      ['write', 1],
    ]);
    expect(lookup.mock.calls.map(([request, template]) => [request.method, template])).toEqual([
      ['POST', '/v1/payoutStatements/:statementId/$markPaid'],
      ['POST', '/v1/offers/:offerId/$delist'],
    ]);
  } finally {
    lookup.mockRestore();
  }
});

test('no missing route or metadata write bypass and invalid whole body spends zero', async () => {
  const malformed = {
    operationId: 'item.create',
    'x-action': 'item:create',
    'x-exposure': 'public',
    'x-rate-limit': { family: 'invented', units: 1 },
  };
  let effects = 0;
  const spends: unknown[] = [];
  const missingDetail = { operationId: 'item.missing', 'x-exposure': 'public' };
  const app = createApp({
    pool,
    writeRate: {
      async spend(_context, family, units) {
        spends.push([family, units]);
        return { allowed: true };
      },
    },
  })
    .post('/missing', { detail: missingDetail }, () => ++effects)
    .post('/malformed', { detail: malformed }, () => ++effects)
    .post(
      '/provider',
      {
        body: t.Object({ event: t.String() }),
        detail: {
          operationId: 'item.provider',
          'x-action': 'item:create',
          'x-exposure': 'public',
          'x-rate-limit': defineRateLimit({ family: 'provider', units: 1 }),
        },
      },
      () => ++effects,
    );
  expect((await app.handle(post('/missing'))).status).toBe(503);
  expect((await app.handle(post('/malformed'))).status).toBe(503);
  expect((await app.handle(post('/absent'))).status).toBe(404);
  expect((await app.handle(post('/provider', { event: 1 }))).status).toBe(400);
  expect(effects).toBe(0);
  expect(spends).toEqual([]);
  expect((await app.handle(post('/provider', { event: 'paid' }))).status).toBe(200);
  expect(spends).toEqual([['provider', 1]]);
  expect(effects).toBe(1);
});

test('legacy-owner declarations include the hidden provider route without x-action', async () => {
  const spends: unknown[] = [];
  const app = createApp({
    pool,
    writeRate: {
      async spend(_context, family, units) {
        spends.push([family, units]);
        return { allowed: true };
      },
    },
  }).post('/v1/webhooks/stripe', { detail: { hide: true } }, () => 'accepted');
  declareKernelWriteRates(app);
  expect((await app.handle(post('/v1/webhooks/stripe'))).status).toBe(200);
  expect(spends).toEqual([['provider', 1]]);
});

test('loopback custom writes retain native method/template selection and reject internal aliases', async () => {
  await openSelling();
  const spends: unknown[] = [];
  const app = createKernel({
    receiptKeys: testReceiptKeys(),
    pool,
    routeKey: new Uint8Array(32),
    writeRate: {
      async spend(_context, family, units) {
        spends.push([family, units]);
        return { allowed: false, retryAfter: 9 };
      },
    },
  });
  app.listen({ hostname: '127.0.0.1', port: 0 });
  try {
    for (const { path, body } of nativeWrites()) {
      const request = post(path, body);
      const response = await fetch(new Request(`${app.server!.url.origin}${path}`, request));
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('9');
      await response.text();
    }
    for (const path of ['/v1/payoutStatements/one/$markPaid', '/v1/offers/two/%24delist']) {
      const response = await fetch(new Request(`${app.server!.url.origin}${path}`, post(path)));
      expect(response.status).toBe(404);
      await response.text();
    }
    expect(spends).toEqual([
      ['write', 1],
      ['write', 1],
    ]);
  } finally {
    await app.stop(true);
  }
});

test('literal native router aliases preserve distinct declarations and encoded paths', async () => {
  const spends: unknown[] = [];
  const app = createApp({
    pool,
    writeRate: {
      async spend(_context, family, units) {
        spends.push([family, units]);
        return { allowed: true };
      },
    },
  })
    .post('/literal', { detail: detail('item:create', 'write') }, () => true)
    .post('/literal/', { detail: detail('item:update', 'report') }, () => true)
    .post('/café', { detail: detail('item:create', 'upload') }, () => true);
  for (const path of ['/literal', '/literal/', '/caf%C3%A9', '/caf%C3%A9/'])
    expect((await app.handle(post(path))).status).toBe(200);
  expect(spends).toEqual([
    ['write', 1],
    ['report', 1],
    ['upload', 1],
    ['upload', 1],
  ]);
});
