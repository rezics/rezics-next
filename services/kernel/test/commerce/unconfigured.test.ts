import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { commerceWorkModule } from '../../src/commerce/work-module.ts';
import { readCommerceConfig, readCommerceWorkerConfig } from '../../src/commerce/config.ts';
import { partitionOf, newId, routeOf } from '../../src/route/route.ts';
import { readConfig, startServer } from '../../src/server.ts';
import type { WorkContext } from '../../src/work/registry.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const commerceVariables = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRETS',
  'STRIPE_MANAGED_PAYMENTS',
  'STRIPE_API_HOST',
  'CHECKOUT_SUCCESS_URL',
  'CHECKOUT_CANCEL_URL',
] as const;

function baseEnvironment() {
  return {
    DATABASE_URL: databaseUrl!,
    KERNEL_ROUTE_KEY: Buffer.alloc(32, 1).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
    KERNEL_PORT: '0',
    KERNEL_WRITE_RATE_SECRET: 'unconfigured-commerce-rate-secret-32-bytes',
  };
}

test('without commerce variables the API starts, serves reads, and refuses orders without writes', async () => {
  const env = baseEnvironment();
  expect(commerceVariables.every((variable) => !(variable in env))).toBe(true);
  expect(readCommerceConfig(env)).toBeNull();
  expect(readCommerceWorkerConfig(env)).toBeNull();
  expect(readConfig(env).commerce).toBeNull();

  const signing = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(signing.publicKey)), kid: 'unconfigured', alg: 'ES256' };
  const jwks = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ keys: [key] }),
  });
  const issuer = new URL(jwks.url.href).origin;
  const authEnv = {
    AUTH_ISSUER: issuer,
    AUTH_AUDIENCE: 'https://api.rezics.test',
    AUTH_JWKS_URL: `${issuer}/jwks`,
  };
  const previousAuth = {
    AUTH_ISSUER: process.env.AUTH_ISSUER,
    AUTH_AUDIENCE: process.env.AUTH_AUDIENCE,
    AUTH_JWKS_URL: process.env.AUTH_JWKS_URL,
  };
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let buyer: string | undefined;

  try {
    Object.assign(process.env, authEnv);
    server = await startServer(readConfig(env));
    buyer = newId(0x3300);
    const buyerRoute = routeOf(buyer)!;
    await admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [buyerRoute, buyer],
    );
    await admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES ($1,$2,$2,'payout_statement:list','(,)',$2)`,
      [buyerRoute, buyer],
    );

    const token = await new SignJWT({
      client_id: 'web',
      scope: 'order:create order:read entitlement:list payout_statement:list exposure:open',
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'unconfigured', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(authEnv.AUTH_AUDIENCE)
      .setSubject(buyer)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey);
    const origin = server.url.href.replace(/\/$/, '');
    const get = (path: string) => fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });

    await bootstrapGovernance(admin, buyer);
    for (const group of ['purchases', 'selling']) {
      const opened = await fetch(`${origin}/v1/platform/exposure/${group}:open`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
        },
      });
      if (opened.status !== 200) throw new Error(`Opening ${group} failed: ${opened.status} ${await opened.text()}`);
    }

    expect((await fetch(`${origin}/health`)).status).toBe(200);
    expect((await get(`/v1/offers/${newId(0x2200)}`)).status).toBe(404);
    expect((await get(`/v1/orders/${newId(buyerRoute)}`)).status).toBe(404);
    expect(await (await get('/v1/entitlements')).json()).toMatchObject({ entitlements: [], next: null });
    expect(await (await get('/v1/payoutStatements')).json()).toMatchObject({ payoutStatements: [], next: null });

    const offerId = newId(0x2200);
    const partition = partitionOf(buyerRoute);
    const before = await admin.query(
      `SELECT (SELECT count(*) FROM commerce.purchase_order) AS orders,
              (SELECT count(*) FROM core.outbox WHERE partition_no = $1) AS events`,
      [partition],
    );
    const refused = await fetch(`${origin}/v1/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify('unconfigured-order-key'),
      },
      body: JSON.stringify({ offerId, expectedOfferRevision: 1 }),
    });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: 'dependency_unavailable' });
    const after = await admin.query(
      `SELECT (SELECT count(*) FROM commerce.purchase_order) AS orders,
              (SELECT count(*) FROM core.outbox WHERE partition_no = $1) AS events`,
      [partition],
    );
    expect(after.rows).toEqual(before.rows);
  } finally {
    await server?.stop();
    await admin.end();
    jwks.stop(true);
    for (const [name, value] of Object.entries(previousAuth)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('partial commerce configuration still names its first missing or invalid variable', () => {
  expect(() => readCommerceConfig({ STRIPE_API_HOST: '' })).toThrow('STRIPE_SECRET_KEY');
  expect(() => readCommerceConfig({ STRIPE_SECRET_KEY: 'sk_test_partial' })).toThrow('STRIPE_WEBHOOK_SECRETS');
  expect(() => readCommerceWorkerConfig({ STRIPE_SECRET_KEY: 'sk_test_partial' })).toThrow('STRIPE_MANAGED_PAYMENTS');
  expect(() => readCommerceConfig({ STRIPE_SECRET_KEY: 'invalid' })).toThrow('STRIPE_SECRET_KEY');
});

test('without commerce variables the commerce worker module registers no work', async () => {
  const registrations: string[] = [];
  const context = {
    env: {},
    addEffects() {
      registrations.push('effects');
    },
    addService() {
      registrations.push('service');
    },
  } as unknown as WorkContext;

  await expect(commerceWorkModule.register(context)).resolves.toBeUndefined();
  expect(registrations).toEqual([]);
});
