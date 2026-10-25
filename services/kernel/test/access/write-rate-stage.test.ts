import { afterAll, beforeEach, expect, test } from 'bun:test';
import { t } from 'elysia';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import { createWriteRateStage } from '../../src/access/write-rate-stage.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url });
const secret = 'a'.repeat(43);
const limiter = (maximum = 205) =>
  createWriteRateLimiter({
    secret,
    overrides: JSON.stringify({ anonymous: { write: { maximum, seconds: 60 } } }),
  });
let effects = 0;
function detail(action: string, family?: 'write' | 'report', units: 1 | 'commands' = 1) {
  return {
    operationId: 'rate.probe',
    'x-action': action,
    ...(family ? { 'x-rate-limit': defineRateLimit({ family, units }) } : {}),
  };
}
function fixture(maximum = 205, source = pool) {
  const app = createApp({ pool: source, writeRate: limiter(maximum), ratePeer: () => '2001:db8::1' });
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
    .post('/unknown', {}, () => ++effects);
}
const request = (path: string, count?: number, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(count === undefined ? {} : { commands: Array.from({ length: count }, () => ({ value: 1 })) }),
  });
beforeEach(async () => {
  effects = 0;
  await pool.query('TRUNCATE access.write_rate_counter');
});
afterAll(() => pool.end());

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
  const app = createKernel({ pool, routeKey: new Uint8Array(32), ratePeer: () => '192.0.2.1' });
  const writes = app.routes.filter((route) => !['GET', 'HEAD', 'OPTIONS'].includes(route.method));
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
