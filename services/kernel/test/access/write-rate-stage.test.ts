import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { t } from 'elysia';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { readExposure } from '../../src/access/gates/catalogue.ts';
import { createAccess } from '../../src/access/index.ts';
import { newId } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import { createWriteRateStage } from '../../src/access/write-rate-stage.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { mountedRouteCatalogue } from '../../src/http/request.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url });
const secret = 'a'.repeat(43);
const limiter = (maximum = 205) =>
  createWriteRateLimiter({
    secret,
    overrides: JSON.stringify({ anonymous: { write: { maximum, seconds: 60 } } }),
  });
process.env.KERNEL_RECEIPT_KEYS = [...testReceiptKeys().keys]
  .map(([version, key]) => `${version}:${Buffer.from(key).toString('base64url')}`)
  .join(',');
let effects = 0;
function detail(action: string, family?: 'write' | 'report', units: 1 | 'commands' = 1) {
  return {
    operationId: 'rate.probe',
    'x-action': action,
    'x-exposure': 'public',
    ...(family ? { 'x-rate-limit': defineRateLimit({ family, units }) } : {}),
  };
}
function fixture(maximum = 205, source = pool) {
  const app = createApp({ pool: source, writeRate: limiter(maximum), ratePeer: () => '2001:db8::1' });
  const unknownDetail = { operationId: 'rate.unknown', 'x-exposure': 'public' };
  return app
    .post('/write', { detail: detail('subject:create', 'write') }, () => ++effects)
    .post(
      '/batch',
      {
        body: t.Object({ commands: t.Array(t.Object({ value: t.Integer() }), { minItems: 1, maxItems: 100 }) }),
        detail: detail('subject:batch_write', 'write', 'commands'),
      },
      ({ body }) => {
        effects += body.commands.length;
        return effects;
      },
    )
    .post('/report', { detail: detail('report:create', 'report') }, () => ++effects)
    .post('/read', { detail: detail('subject:read') }, () => 'read')
    .post('/unknown', { detail: unknownDetail }, () => ++effects);
}
const request = (path: string, count?: number, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(count === undefined ? {} : { commands: Array.from({ length: count }, () => ({ value: 1 })) }),
  });
const opening = Bun.randomUUIDv7();
beforeAll(async () => {
  for (const group of ['search', 'search_advanced', 'selling']) {
    if (!(await readExposure(pool, group, new Date(), Date.now() + 10_000)).open) {
      await pool.query(
        `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
         VALUES ($1, tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), $2)`,
        [group, opening],
      );
    }
  }
});
beforeEach(async () => {
  effects = 0;
  await pool.query('TRUNCATE access.write_rate_counter');
});
afterAll(async () => {
  await pool.query('DELETE FROM access.exposure_opening WHERE transaction_id = $1', [opening]);
  await pool.end();
});

test('native HTTP stage spends the complete batch once before effects and preserves rejected expiry', async () => {
  const app = fixture();
  expect((await app.handle(request('/write'))).status).toBe(200);
  expect((await app.handle(request('/batch', 100))).status).toBe(200);
  expect((await app.handle(request('/batch', 100))).status).toBe(200);
  const before = (await pool.query('SELECT count, expires_at FROM access.write_rate_counter')).rows;
  expect(before).toHaveLength(1);
  expect(before[0].count).toBe(201);
  const denied = await app.handle(request('/batch', 5));
  expect(denied.status).toBe(429);
  expect(denied.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
  expect(denied.headers.get('cache-control')).toBe('no-store');
  expect(await denied.json()).toMatchObject({ code: 'rate_limited', effect_status: 'not_applied', retryable: true });
  expect(effects).toBe(201);
  expect((await pool.query('SELECT count, expires_at FROM access.write_rate_counter')).rows).toEqual(before);
  expect((await app.handle(request('/batch', 4))).status).toBe(200);
  expect(effects).toBe(205);
  expect((await app.handle(request('/report'))).status).toBe(200);
  expect((await app.handle(request('/read'))).status).toBe(200);
  expect((await pool.query('SELECT family FROM access.write_rate_counter ORDER BY family')).rows).toEqual([
    { family: 'report' },
    { family: 'write' },
  ]);
});

test('whole-body validation spends nothing and unknown writes fail closed', async () => {
  const app = fixture();
  expect((await app.handle(request('/batch', 101))).status).toBe(400);
  expect((await app.handle(request('/batch', 0))).status).toBe(400);
  expect((await app.handle(request('/unknown'))).status).toBe(503);
  expect(effects).toBe(0);
  expect((await pool.query('SELECT * FROM access.write_rate_counter')).rows).toHaveLength(0);
});

test('concurrent batches admit at most the full maximum without partial debit', async () => {
  const app = fixture(205);
  const results = await Promise.all(Array.from({ length: 8 }, () => app.handle(request('/batch', 100))));
  expect(results.filter((r) => r.status === 200)).toHaveLength(2);
  expect(results.filter((r) => r.status === 429)).toHaveLength(6);
  expect(effects).toBe(200);
  expect((await pool.query('SELECT count FROM access.write_rate_counter')).rows).toEqual([{ count: 200 }]);
});

test('store outage and missing deployment key fail before side effects', async () => {
  const closed = new Pool({ connectionString: url });
  await closed.end();
  const response = await fixture(205, closed).handle(request('/batch', 100));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'rate_limit_unavailable', effect_status: 'not_applied' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(effects).toBe(0);
});

test('forged forwarding and class fields cannot select capacity; IPv6 interface rotation shares a window', async () => {
  const app = fixture(1);
  expect(
    (await app.handle(request('/write', undefined, { 'x-forwarded-for': '1.2.3.4', 'x-rate-class': 'service' })))
      .status,
  ).toBe(200);
  expect((await app.handle(request('/write', undefined, { 'x-forwarded-for': '4.3.2.1' }))).status).toBe(429);
  const second = createApp({ pool, writeRate: limiter(1), ratePeer: () => '2001:0db8:0:0:ffff::2' }).post(
    '/write',
    { detail: detail('subject:create', 'write') },
    () => ++effects,
  );
  expect((await second.handle(request('/write'))).status).toBe(429);
  expect(effects).toBe(1);
});

test('one opaque request charge covers duplicate stage invocation and refuses a different bulk total', async () => {
  const stage = createWriteRateStage(limiter());
  const req = request('/batch', 100);
  const context = { pool, actor: { kind: 'anonymous' as const }, deadline: Date.now() + 5000 };
  const input = {
    request: req,
    context,
    peer: '192.0.2.1',
    body: { commands: Array(100).fill({}) },
    routes: [{ method: 'POST', path: '/batch', hooks: { detail: detail('subject:batch_write', 'write', 'commands') } }],
  };
  await Promise.all([stage(input), stage(input)]);
  expect((await pool.query('SELECT count FROM access.write_rate_counter')).rows).toEqual([{ count: 100 }]);
  await expect(stage({ ...input, body: { commands: [{}] } })).rejects.toMatchObject({ code: 'rate_limit_unavailable' });
});

test('the default kernel composition declares every mounted write and installs the real limiter', async () => {
  const app = createKernel({
    pool,
    routeKey: new Uint8Array(32),
    receiptKeys: testReceiptKeys(),
    ratePeer: () => '192.0.2.1',
  });
  const writes = mountedRouteCatalogue(app).routes.filter((route) => {
    const detail = route.hooks?.detail as Record<string, unknown> | undefined;
    const action = detail?.['x-action'];
    const readOnly = typeof action === 'string' && /:(?:read|list)(?:_[a-z][a-z_]*)?(?![\s\S])/.test(action);
    return !['GET', 'HEAD', 'OPTIONS'].includes(route.method) && !readOnly;
  });
  expect(writes.length).toBeGreaterThan(0);
  for (const route of writes) expect(route.hooks?.detail).toHaveProperty('x-rate-limit');
  // A body-valid anonymous definition write reaches shared capacity before its handler.
  const fixture = createApp({ pool, ratePeer: () => '192.0.2.1' }).post(
    '/write',
    { detail: detail('subject:create', 'write') },
    () => ++effects,
  );
  const response = await fixture.handle(request('/write'));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'rate_limit_unavailable' });
  expect(effects).toBe(0);
});

test('createKernel subject:read POST custom search authorizes without a write charge', async () => {
  const actions: string[] = [];
  const searches: unknown[] = [];
  let spends = 0;
  const result = {
    subjects: [],
    next: null,
    as_of: '2026-10-25T00:00:00.000Z',
  };
  const app = createKernel({
    pool,
    routeKey: new Uint8Array(32),
    receiptKeys: testReceiptKeys(),
    access: ({ actions: catalogue }) => {
      expect(catalogue.get('subject:read')).toEqual({
        anonymous: true,
        'x-resource-types': ['community.realm', 'semantic.context', 'semantic.subject'],
      });
      return {
        async authenticate() {
          throw new Error('unused');
        },
        async authorize(_client, _actor, action) {
          actions.push(action);
          return true;
        },
      };
    },
    writeRate: {
      async spend() {
        spends++;
        throw new Error('Read-only search must not spend write capacity');
      },
    },
    search: {
      async releaseGroups() {
        throw new Error('unused');
      },
      async savedCatalogueMembers() {
        throw new Error('unused');
      },
      async search(principal, body, _now, _active, context) {
        searches.push([principal, body]);
        await context?.complete(result);
        return result;
      },
      async suggest() {
        throw new Error('unused');
      },
      async facets() {
        throw new Error('unused');
      },
    },
  });
  const send = (body: unknown) =>
    app.handle(
      new Request('http://localhost/v1/subjects:search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-action': 'subject:create', 'x-rate-family': 'write' },
        body: JSON.stringify(body),
      }),
    );
  expect((await send({ text: 1 })).status).toBe(400);
  expect(searches).toEqual([]);
  const response = await send({ text: 'book' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(actions).toEqual(['subject:read']);
  expect(searches).toEqual([['anonymous', { text: 'book' }]]);
  expect(spends).toBe(0);
  expect((await pool.query('SELECT count FROM access.write_rate_counter')).rows).toEqual([]);
});

test('trusted exact proxy attribution honors only its configured replaced header', async () => {
  const app = createApp({
    pool,
    writeRate: limiter(1),
    ratePeer: () => '127.0.0.1',
    rateAttribution: { trustedProxyPeers: ['127.0.0.1'], clientIpHeader: 'cf-connecting-ip' },
  }).post('/write', { detail: detail('subject:create', 'write') }, () => ++effects);
  for (const address of ['192.0.2.1', '192.0.2.2']) {
    expect((await app.handle(request('/write', undefined, { 'cf-connecting-ip': address }))).status).toBe(200);
    expect((await app.handle(request('/write', undefined, { 'cf-connecting-ip': address }))).status).toBe(429);
  }
  expect((await pool.query('SELECT * FROM access.write_rate_counter')).rows).toHaveLength(2);
  expect(() => createWriteRateStage(limiter(), { trustedProxyPeers: ['127.1'] })).toThrow();
});

test('malformed bearer retains authentication semantics and never spends', async () => {
  const response = await fixture().handle(request('/write', undefined, { authorization: 'Bearer invalid' }));
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect((await pool.query('SELECT * FROM access.write_rate_counter')).rows).toHaveLength(0);
  expect(effects).toBe(0);
});

test('semantic read-only POST failures use the common action-aware problem envelope', async () => {
  const app = createApp({ pool }).post('/read', { detail: detail('subject:read') }, () => {
    throw new Error('unavailable');
  });
  const response = await app.handle(request('/read'));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ effect_status: 'not_applicable' });
  expect((await pool.query('SELECT * FROM access.write_rate_counter')).rows).toHaveLength(0);
});

test('expired native windows reset atomically for the next full batch', async () => {
  const app = fixture(100);
  expect((await app.handle(request('/batch', 100))).status).toBe(200);
  const original = (await pool.query('SELECT expires_at FROM access.write_rate_counter')).rows[0].expires_at;
  await pool.query("UPDATE access.write_rate_counter SET expires_at=statement_timestamp() - interval '1 second'");
  expect((await app.handle(request('/batch', 100))).status).toBe(200);
  const row = (await pool.query('SELECT count, expires_at FROM access.write_rate_counter')).rows[0];
  expect(row.count).toBe(100);
  expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(original.getTime());
  expect(effects).toBe(200);
});

test('createKernel payout markPaid and offer delist spend once before effect with a native account counter', async () => {
  // Payout and offer writes sit behind the selling gate, which the platform opens explicitly.
  await pool.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('selling', tstzrange('2000-01-01T00:00:00Z'::timestamptz, NULL, '[)'), $1)
     ON CONFLICT DO NOTHING`,
    [Bun.randomUUIDv7()],
  );
  const route = 0x2200;
  const account = newId(route),
    statement = newId(route),
    offer = newId(route);
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [route, account],
  );
  await pool.query(
    "INSERT INTO commerce.payout_statement(route,statement_id,creator_account_id,period,currency) VALUES ($1,$2,$3,'1900-01','usd')",
    [route, statement, account],
  );
  await pool.query(
    `INSERT INTO commerce.offer(route,offer_id,creator_account_id,target_subject_id,title,currency,unit_amount_minor,tax_code,royalty_basis_points,state,revision,created_at,updated_at,transaction_id)
    VALUES ($1,$2,$3,$4,'Book','usd',1000,'txcd_10302000',9000,'active',1,now(),now(),$2)`,
    [route, offer, account, newId(0x5500)],
  );
  for (const [anchor, resource, action] of [
    [0, GLOBAL_CONTEXT, 'payout_statement:mark_paid'],
    [route, offer, 'offer:manage'],
  ] as const)
    await pool.query(
      "INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$3)",
      [anchor, resource, account, action],
    );
  const pair = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'mounted-rate', alg: 'ES256' };
  const token = await new SignJWT({
    client_id: 'web',
    scope: 'payout_statement:mark_paid offer:manage',
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'mounted-rate', typ: 'at+jwt' })
    .setIssuer('https://auth.test')
    .setAudience('https://kernel.test')
    .setSubject(account)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(pair.privateKey);
  const real = createWriteRateLimiter({
    secret,
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 2, seconds: 60 } } }),
  });
  const spends: unknown[] = [];
  const states = async () => [
    (
      await pool.query('SELECT state,revision FROM commerce.payout_statement WHERE route=$1 AND statement_id=$2', [
        route,
        statement,
      ])
    ).rows[0],
    (await pool.query('SELECT state,revision FROM commerce.offer WHERE route=$1 AND offer_id=$2', [route, offer]))
      .rows[0],
  ];
  const app = createKernel({
    pool,
    routeKey: new Uint8Array(32),
    receiptKeys: testReceiptKeys(),
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.test',
          audience: 'https://kernel.test',
          jwksUrl: 'https://auth.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
    writeRate: {
      async spend(context, family, units) {
        spends.push([family, units, await states()]);
        return real.spend(context, family, units);
      },
    },
  });
  const send = (path: string, body: unknown) =>
    app.handle(
      new Request(`https://kernel.test${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
        },
        body: JSON.stringify(body),
      }),
    );
  expect((await send(`/v1/payoutStatements/${statement}:markPaid`, {})).status).toBe(400);
  expect(spends).toEqual([]);
  expect((await pool.query('SELECT count FROM access.write_rate_counter')).rows).toEqual([]);
  const paid = await send(`/v1/payoutStatements/${statement}:markPaid`, { paidReference: 'wire' });
  expect(paid.status).toBe(200);
  expect(await paid.json()).toMatchObject({
    statement: { id: statement, state: 'paid', paidReference: 'wire', revision: 2 },
  });
  const delisted = await send(`/v1/offers/${offer}:delist`, {});
  expect(delisted.status).toBe(200);
  expect(await delisted.json()).toMatchObject({ offer: { id: offer, state: 'delisted' } });
  const before = await states();
  const rejected = await send(`/v1/payoutStatements/${statement}:markPaid`, { paidReference: 'another-wire' });
  expect(rejected.status).toBe(429);
  expect(rejected.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
  expect(await states()).toEqual(before);
  expect(spends).toEqual([
    [
      'write',
      1,
      [
        { state: 'open', revision: 1 },
        { state: 'active', revision: 1 },
      ],
    ],
    [
      'write',
      1,
      [
        { state: 'paid', revision: 2 },
        { state: 'active', revision: 1 },
      ],
    ],
    ['write', 1, before],
  ]);
  expect((await pool.query('SELECT route,family,count FROM access.write_rate_counter')).rows).toEqual([
    { route, family: 'write', count: 2 },
  ]);
});
