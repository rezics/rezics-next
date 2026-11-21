import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createApp } from '../../src/http/app.ts';
import { Admission } from '../../src/http/admission.ts';
import { customMethod } from '../../src/http/custom-method.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import { readConfig } from '../../src/server.ts';
import { testReceiptKeysEnv } from '../support/receipt-keys.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const secret = 'transport-private-secret-of-at-least-32-bytes';
beforeEach(() => pool.query('TRUNCATE access.write_rate_counter'));
afterAll(() => pool.end());

test('real socket attribution survives dynamic custom-method rewriting and ignores forwarding headers', async () => {
  let effects = 0;
  const detail = {
    operationId: 'item.update',
    'x-action': 'item:update',
    'x-exposure': 'public',
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  };
  const app = createApp({
    pool,
    writeRate: createWriteRateLimiter({ secret, overrides: '{"anonymous":{"write":{"maximum":1,"seconds":60}}}' }),
  }).post(
    customMethod('/items/:id', 'update'),
    {
      detail,
    },
    () => ++effects,
  );
  app.listen({ hostname: '127.0.0.1', port: 0 });
  try {
    const origin = app.server!.url.origin;
    const first = await fetch(`${origin}/items/one:update`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.1' },
    });
    expect(first.status).toBe(200);
    await first.text();
    const denied = await fetch(`${origin}/items/two:update`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.2' },
    });
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({ code: 'rate_limited', effect_status: 'not_applied' });
    expect(effects).toBe(1);
    const identity = createHmac('sha256', secret).update('anonymous:127.0.0.1').digest('hex');
    expect((await pool.query('SELECT identity_digest, count FROM access.write_rate_counter')).rows).toEqual([
      { identity_digest: identity, count: 1 },
    ]);
  } finally {
    await app.stop(true);
  }
});

test('dynamic read-only POST validation uses action-aware problems and spends no capacity', async () => {
  const detail = { operationId: 'item.read', 'x-action': 'item:read', 'x-exposure': 'public' };
  const app = createApp({ pool }).post('/items/:id', { detail }, () => {
    throw new Error('offline');
  });
  const response = await app.handle(new Request('http://localhost/items/one', { method: 'POST' }));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ effect_status: 'not_applicable' });
  expect((await pool.query('SELECT count(*)::integer AS count FROM access.write_rate_counter')).rows).toEqual([
    { count: 0 },
  ]);
});

test('only preflight with native work needs a normal permit', async () => {
  const admission = new Admission({ permits: 1, reserved: 1, queue: 0 });
  const read = { operationId: 'item.read', 'x-action': 'item:read', 'x-exposure': 'public' };
  const write = {
    operationId: 'item.write',
    'x-action': 'item:update',
    'x-exposure': 'public',
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  };
  const app = createApp({ pool, admission })
    .post('/read', { detail: read }, () => 1)
    .post('/write', { detail: write }, () => 2);
  await admission.run('normal', { deadline: Date.now() + 2_000 }, async () => {
    const post = (path: string) => app.handle(new Request('http://localhost/' + path, { method: 'POST' }));
    expect((await post('read')).status).toBe(200);
    const response = await post('write');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'overloaded' });
  });
});

test('ALL-mounted read actions retain the common problem effect status', async () => {
  const detail = { operationId: 'item.read', 'x-action': 'item:read', 'x-exposure': 'public' };
  const app = createApp({ pool }).all('/read', { detail }, () => {
    throw new Error('offline');
  });
  const response = await app.handle(new Request('http://localhost/read', { method: 'POST' }));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ effect_status: 'not_applicable' });
});

test('server environment validates private key, strict policy overrides and exact proxy peers', () => {
  const env = {
    DATABASE_URL: process.env.DATABASE_URL,
    KERNEL_ROUTE_KEY: Buffer.alloc(32).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32).toString('base64url')}`,
    ...testReceiptKeysEnv(),
    KERNEL_WRITE_RATE_SECRET: secret,
    KERNEL_RATE_TRUSTED_PROXY_PEERS: '127.0.0.1,::1',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_WEBHOOK_SECRETS: 'whsec_fixture',
    STRIPE_MANAGED_PAYMENTS: 'false',
    CHECKOUT_SUCCESS_URL: 'https://example.test/success',
    CHECKOUT_CANCEL_URL: 'https://example.test/cancel',
  };
  expect(readConfig(env).writeRate).toHaveProperty('spend');
  expect(() => readConfig({ ...env, KERNEL_WRITE_RATE_SECRET: 'short' })).toThrow();
  expect(() =>
    readConfig({ ...env, KERNEL_WRITE_RATE_OVERRIDES: '{"service":{"write":{"maximum":1,"seconds":60,"extra":1}}}' }),
  ).toThrow();
  expect(() => readConfig({ ...env, KERNEL_RATE_TRUSTED_PROXY_PEERS: '127.0.0.0/8' })).toThrow();
});
