import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { PoolClient } from 'pg';
import {
  boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode,
} from '../../../services/main/src/infrastructure/pg-pool.ts';
import type { VerifiedAccountAssertion } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { rateLimitBudgets } from '../../../services/main/src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../../../services/main/src/modules/rate-limit/hook.ts';
import {
  PostgresRateLimitStore, type RateLimitOptions, type RateLimitStore,
} from '../../../services/main/src/modules/rate-limit/store.ts';

function accessUrl(): string {
  const value = Bun.env.ACCESS_DATABASE_URL;
  if (!Bun.env.REZICS_QA_RUN_ID || !value) throw new Error('Run through the isolated QA integration tier');
  return value;
}

test('verified search spends the member budget, a person keeps their class, and pool checkout fails closed', async () => {
  const connectionString = accessUrl();
  const secret = `principal-budget-${randomUUID()}-secret-32`;
  const issuer = `https://account.example.test/principal-budget/${randomUUID()}`;
  const subject = randomUUID();
  const options: RateLimitOptions = {
    secret, serviceClientIds: new Set(['installed-importer']),
    trustedProxyPeers: new Set(), clientIpHeader: 'x-forwarded-for',
  };
  const access = boundedPool({ connectionString, max: 2 });
  const waitPool = boundedPool({ connectionString, max: 1, connectionTimeoutMillis: 300 });
  const nestedPool = boundedPool({ connectionString, max: 2, connectionTimeoutMillis: 2_000 });
  const postgres = new PostgresRateLimitStore(access, options);
  const store: RateLimitStore = {
    classify: principal => postgres.classify(principal),
    consume: (identity, family, budget) => postgres.consume(identity, family, budget),
  };
  const memberKey = createHmac('sha256', secret).update(JSON.stringify([issuer, subject])).digest('hex');
  const anonymousKey = createHmac('sha256', secret).update('anonymous:unknown').digest('hex');
  let holder: PoolClient | undefined;
  let nestedClient: PoolClient | undefined;
  const previous = nestedPoolCheckoutMode();
  try {
    await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject, first_seen_at)
      VALUES ($1, $2, $3, now() - interval '8 days')`, [randomUUID(), issuer, subject]);
    const budgets = rateLimitBudgets(JSON.stringify({ member: { search: { maximum: 1, seconds: 60 } } }));
    const app = new Elysia().use(rateLimitHook({
      async verify(): Promise<VerifiedAccountAssertion> {
        return {
          issuer, subject, accountClientId: 'installed-importer', accountAuthMode: 'consent',
          accountExpiresAt: Math.floor(Date.now() / 1000) + 300,
        };
      },
    }, { store, options, budgets }))
      .post('/v1/query', () => 'results')
      .get('/v1/discovery/concepts', () => 'topics');
    const first = await app.handle(new Request('http://localhost/v1/query', {
      method: 'POST', headers: { authorization: 'Bearer member' },
    }));
    expect(first.status).toBe(200);
    const topic = await app.handle(new Request('http://localhost/v1/discovery/concepts?q=topic', {
      headers: { authorization: 'Bearer member' },
    }));
    expect(topic.status).toBe(429);
    expect((await topic.json()).family).toBe('search');
    const anonymous = await app.handle(new Request('http://localhost/v1/discovery/concepts?q=topic'));
    expect(anonymous.status).toBe(200);
    const counter = await access.query<{ count: number; family: string }>(
      `SELECT count, family FROM access.rate_limit_v1 WHERE key = $1`, [memberKey]);
    expect(counter.rows).toEqual([{ count: 2, family: 'search' }]);
    const person: VerifiedAccountAssertion = {
      issuer, subject, accountClientId: 'installed-importer', accountAuthMode: 'consent',
    };
    expect(await postgres.classify(person)).toBe('member');
    expect(await postgres.classify({ ...person, accountAuthMode: 'workload' })).toBe('member');
    expect(await postgres.classify({
      issuer, subject: 'installed-importer', accountClientId: 'installed-importer', accountAuthMode: 'workload',
    })).toBe('service');

    holder = await new Promise<PoolClient>((resolve, reject) => {
      waitPool.connect((err, client) => {
        if (err || !client) reject(err ?? new Error('checkout failed'));
        else resolve(client);
      });
    });
    const started = performance.now();
    const timeout = await waitPool.query('SELECT 1').then(() => undefined, (error: Error) => error);
    const elapsed = performance.now() - started;
    expect(timeout?.message).toBe('timeout exceeded when trying to connect');
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
    holder.release();
    holder = undefined;

    setNestedPoolCheckoutMode('throw');
    await nestedPool.query('SELECT 1');
    await nestedPool.query('SELECT 1');
    nestedClient = await nestedPool.connect();
    await expect(nestedPool.query('SELECT 1')).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    await expect(nestedPool.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    nestedClient.release();
    nestedClient = undefined;
    await nestedPool.query('SELECT 1');
  } finally {
    setNestedPoolCheckoutMode(previous);
    try { holder?.release(); } catch { /* already released */ }
    try { nestedClient?.release(); } catch { /* already released */ }
    try {
      await access.query(`DELETE FROM access.rate_limit_v1 WHERE key = $1 OR key = $2`, [memberKey, anonymousKey]);
      await access.query(`DELETE FROM access.principal WHERE account_issuer = $1`, [issuer]);
    } finally {
      await Promise.all([access.end(), waitPool.end(), nestedPool.end()]);
    }
  }
}, 30_000);
