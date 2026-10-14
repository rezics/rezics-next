import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { httpTelemetry } from '@rezics/observability/elysia';
import { rateLimitBudgets, rateLimitFamily, families } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { anonymousIdentity, PostgresRateLimitStore, type RateLimitOptions } from '../src/modules/rate-limit/store.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable } from '../src/modules/account/verify-assertion.ts';
import { createMainApp } from '../src/app.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { mainRequestHeaders } from '../../../apps/web/features/api/bff.ts';
import { PrincipalBudgetCache } from '../src/modules/rate-limit/principal-cache.ts';
import { appEnvironment } from '../../../scripts/dev/config.ts';
import { compareMigrationPaths } from '../../../scripts/lib/migration-order.ts';
import { ReaderLibraryImportStore } from '../src/modules/library-import/reader-import.ts';
import { exposureDeclarations } from '../src/modules/access/exposure-declarations.ts';

const options: RateLimitOptions = { secret: 'g543-test-counter-secret-at-least-32-characters',
  serviceClientIds: new Set(['installed-importer']), trustedProxyPeers: new Set(['127.0.0.2']),
  clientIpHeader: 'x-forwarded-for' };

test('G-543: every current OpenAPI operation has an explicit policy and path boundaries protect safety budgets', () => {
  // Generation consumes these authored operations. The installed-route guard
  // below also covers routes added before their OpenAPI declaration exists.
  // Neither inventory needs schema rendering or a potentially stale artifact.
  const spec: { paths: Record<string, Record<string, unknown>> } = { paths: {} };
  for (const owner of exposureDeclarations) for (const [path, methods] of Object.entries(owner)) {
    spec.paths[path] = { ...spec.paths[path], ...methods };
  }
  let mutations = 0;
  const missing: string[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) for (const method of Object.keys(methods)) {
    if (method === 'parameters') continue;
    if (rateLimitFamily(method.toUpperCase(), path) === undefined) missing.push(`${method.toUpperCase()} ${path}`);
    mutations++;
  }
  const migrations = resolve(import.meta.dir, '../migrations/access');
  let admittedFamilies: string[] = [];
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort(compareMigrationPaths)) {
    const sql = readFileSync(join(migrations, file), 'utf8');
    if (!/CREATE TABLE access\.rate_limit_v1|ALTER TABLE access\.rate_limit_v1 ADD CONSTRAINT rate_limit_v1_family_check/.test(sql)) continue;
    const check = /CHECK\s*\(family IN\s*\(([^)]+)\)\)/.exec(sql);
    if (check) admittedFamilies = [...check[1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!);
  }
  expect(admittedFamilies).toEqual(expect.arrayContaining([...families]));
  expect(missing).toEqual([]);
  expect(mutations).toBeGreaterThan(50);
  expect(rateLimitFamily('GET', '/v1/works')).toBeNull();
  expect(rateLimitFamily('POST', '/v1/query')).toBe('search');
  expect(rateLimitFamily('POST', '/v1/resources/summaries')).toBeNull();
  for (const path of ['/v1/rating-aggregates', '/v1/global-rating-aggregates', '/v1/rating-syntheses',
    '/v1/classification-resolutions', '/v1/statement-resolutions', '/v1/context-interpretations']) {
    expect(rateLimitFamily('POST', path)).toBeNull();
  }
  expect(rateLimitFamily('POST', '/v1/subscriptions/quotes')).toBe('write');
  expect(rateLimitFamily('POST', '/v1/new-unclassified-operation')).toBeUndefined();
  expect(rateLimitFamily('GET', '/v1/unclassified-read')).toBeUndefined();
  expect(rateLimitFamily('HEAD', '/v1/works')).toBeNull();
  expect(rateLimitFamily('GET', '/v1/me/platform-access')).toBeNull();
  expect(rateLimitFamily('HEAD', '/v1/me/platform-access')).toBeNull();
  expect(rateLimitFamily('POST', '/v1/queries')).toBe('search');
  expect(rateLimitFamily('POST', '/v1/queries/page')).toBe('search');
  expect(rateLimitFamily('PUT', '/v1/media/uploads/123/bytes')).toBe('upload');
  expect(rateLimitFamily('POST', '/v1/media/uploads-evil')).toBeUndefined();
  expect(rateLimitFamily('POST', '/v1/public-reports')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/appeals')).toBeUndefined();
  expect(rateLimitFamily('POST', '/v1/rights/complaints')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/public-reports/123/correspondence')).toBe('correspondence');
  expect(rateLimitFamily('POST', '/v1/cases/123/messages')).toBeUndefined();
  expect(() => rateLimitBudgets('{"member":{"write":{"maximum":0,"seconds":60}}}')).toThrow();
  expect(() => rateLimitBudgets('{"service":{"wriet":{"maximum":1,"seconds":60}}}')).toThrow();
});

test('G-543 review: hook caches token class while owner authorization remains current', async () => {
  let classifications = 0, counters = 0, effects = 0, revoked = false;
  const identities: string[] = [];
  const account = { async verify() {
    if (revoked) throw new AccountAssertionDenied();
    return { issuer: 'account', subject: 'same', accountExpiresAt: Date.now() / 1000 + 300 };
  } };
  const app = new Elysia().use(rateLimitHook(account, { options, budgets: rateLimitBudgets(), store: {
    async classify() { classifications++; return 'member'; },
    async consume(identity) { identities.push(identity); counters++; return { allowed: true, retryAfter: 60 }; },
  } })).post('/v1/works', async () => {
    try { await account.verify(); effects++; return 'effect'; }
    catch { return new Response('refused', { status: 401 }); }
  });
  const send = (token: string) => app.handle(new Request('http://localhost/v1/works', {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  }));
  for (let i = 0; i < 10; i++) expect((await send('token-1')).status).toBe(200);
  expect(classifications).toBe(1); expect(counters).toBe(10);
  expect((await send('token-2')).status).toBe(200);
  expect(classifications).toBe(2);
  expect(new Set(identities).size).toBe(1);
  revoked = true;
  expect((await send('token-1')).status).toBe(401);
  expect(effects).toBe(11); expect(classifications).toBe(2);
});

test('G-543 review: read POSTs survive counter loss; safety and provider intake do not depend on bearer health', async () => {
  let verifications = 0;
  const budgets = rateLimitBudgets();
  const seen: Array<{ family: string; maximum: number }> = [];
  const store = { async classify() { throw new Error('Access outage'); },
    async consume(_identity: string, family: string, budget: { maximum: number }) {
      seen.push({ family, maximum: budget.maximum });
      return { allowed: true, retryAfter: 60 };
    } };
  for (const error of [new AccountAssertionDenied('suspended'), new AccountAssertionDenied('rejected'),
    new AccountAssertionUnavailable('Account outage')]) {
    const app = new Elysia().use(rateLimitHook({ async verify() { verifications++; throw error; } },
      { options, budgets, store }))
      .post('/v1/query', () => 'read').post('/v1/resources/summaries', () => 'read')
      .post('/v1/public-reports', () => 'received')
      .post('/v1/public-reports/case/correspondence', () => 'received')
      .post('/v1/subscriptions/settlements', () => 'signed callback')
      .post('/v1/new-unclassified-operation', () => 'effect');
    for (const path of ['/v1/resources/summaries', '/v1/public-reports', '/v1/public-reports/case/correspondence',
      '/v1/subscriptions/settlements']) {
      expect((await app.handle(new Request(`http://localhost${path}`, { method: 'POST',
        headers: { authorization: 'Bearer rejected' } }))).status).toBe(200);
    }
    expect((await app.handle(new Request('http://localhost/v1/new-unclassified-operation', { method: 'POST' }))).status).toBe(503);
  }
  expect(verifications).toBe(0);
  expect(seen.every(entry => entry.family === 'report' || entry.family === 'correspondence' || entry.family === 'provider')).toBe(true);
  expect(seen.filter(entry => entry.family === 'provider').every(entry => entry.maximum > 10)).toBe(true);
  store.consume = async () => { throw new Error('counter outage'); };
  const reads = new Elysia().use(rateLimitHook({ async verify() { throw new Error('Account outage'); } },
    { options, budgets, store })).post('/v1/query', () => 'read').post('/v1/resources/summaries', () => 'read');
  for (const path of ['/v1/resources/summaries']) {
    expect((await reads.handle(new Request(`http://localhost${path}`, { method: 'POST' }))).status).toBe(200);
  }
});

test('G-543 review: token attribution coalesces, expires, and has bounded storage; counters use one operation', async () => {
  let now = 1000, verified = 0, classified = 0;
  const cache = new PrincipalBudgetCache(2, () => now);
  const verify = async () => { verified++; return { issuer: 'account', subject: 'same', accountExpiresAt: 2 }; };
  const classify = async () => { classified++; return 'member' as const; };
  await Promise.all(Array.from({ length: 40 }, () => cache.resolve('token-1', verify, classify)));
  expect(verified).toBe(1); expect(classified).toBe(1);
  await cache.resolve('token-2', verify, classify);
  await cache.resolve('token-3', verify, classify);
  await cache.resolve('token-1', verify, classify);
  expect(verified).toBe(4);
  now = 2001;
  await cache.resolve('token-1', verify, classify);
  expect(verified).toBe(5);
  let queries = 0;
  const store = new PostgresRateLimitStore({ async query() {
    queries++; return { rows: [{ allowed: true, retry_after: 60 }] };
  } } as unknown as Pool, options);
  await store.consume('identity', 'write', { maximum: 10, seconds: 60 });
  expect(queries).toBe(1);
});

test('G-543 review: BFF replaces spoofed IP and stack/import policies come from configuration', async () => {
  const forwarded = mainRequestHeaders(new Headers({ 'cf-connecting-ip': '198.51.100.7',
    'x-rezics-client-ip': '203.0.113.1', 'x-forwarded-for': '203.0.113.2' }), undefined);
  expect(forwarded.get('x-rezics-client-ip')).toBe('198.51.100.7');
  expect(mainRequestHeaders(new Headers({ 'x-rezics-client-ip': '203.0.113.1' }), undefined)
    .has('x-rezics-client-ip')).toBe(false);
  const proxyOptions = { ...options, trustedProxyPeers: new Set(['127.0.0.2']), clientIpHeader: 'x-rezics-client-ip' };
  const request = new Request('http://localhost/v1/works', { headers: forwarded });
  expect(anonymousIdentity(request, '127.0.0.2', proxyOptions)).toBe('anonymous:198.51.100.7');
  expect(anonymousIdentity(request, '127.0.0.1', proxyOptions)).toBe('anonymous:127.0.0.1');
  const env = appEnvironment({ MAIN_RATE_LIMIT_BUDGETS: '{"member":{"write":{"maximum":321,"seconds":60}}}',
    MAIN_READER_IMPORT_ACQUISITIONS_PER_DAY: '77' }, '.temp/g-543-config');
  expect(rateLimitBudgets(env.MAIN_RATE_LIMIT_BUDGETS).member.write.maximum).toBe(321);
  const limits: number[] = [];
  const imports = new ReaderLibraryImportStore({ async query(_sql: string, values: unknown[]) {
    limits.push(values[2] as number); return { rowCount: 1 };
  } } as unknown as Pool, { sourceSearchesPerDay: 321, acquisitionsPerDay: Number(env.MAIN_READER_IMPORT_ACQUISITIONS_PER_DAY) });
  await imports.takeBudget(`https://rezics.com/id/${Bun.randomUUIDv7()}`, 'acquisition');
  expect(limits).toEqual([77]);
});

test('G-543: untrusted peers cannot rotate anonymous identities with forwarded headers', () => {
  const request = (ip: string) => new Request('http://localhost/v1/public-reports', { headers: { 'x-forwarded-for': ip } });
  expect(anonymousIdentity(request('1.1.1.1'), '127.0.0.1', options))
    .toBe(anonymousIdentity(request('2.2.2.2'), '127.0.0.1', options));
  expect(anonymousIdentity(request('1.1.1.1'), '127.0.0.2', options)).toBe('anonymous:1.1.1.1');
  expect(anonymousIdentity(request('1.1.1.1, 2.2.2.2'), '127.0.0.2', options)).toBe('anonymous:127.0.0.2');
  expect(anonymousIdentity(request('1.1.1.1'), undefined, options)).toBe('anonymous:unknown');
});

test('G-543 review: IPv6 interface rotation shares one canonical /64 budget', () => {
  const identity = (ip: string) => anonymousIdentity(new Request('http://localhost'), ip, options);
  expect(identity('2001:db8:1234:abcd::1')).toBe(identity('2001:0DB8:1234:ABCD:ffff:ffff:ffff:ffff'));
  expect(identity('2001:db8:1234:abce::1')).not.toBe(identity('2001:db8:1234:abcd::1'));
  expect(identity('::1')).toBe(identity('0:0:0:0:0:0:0:ffff'));
  expect(identity('2001:db8::192.0.2.1')).toBe(identity('2001:db8:0:0:ffff::1'));
  const trusted = anonymousIdentity(new Request('http://localhost', {
    headers: { 'x-forwarded-for': '2001:db8:1234:abcd::dead' },
  }), '127.0.0.2', options);
  expect(trusted).toBe(identity('2001:db8:1234:abcd::1'));
});

test('G-543: global hook reaches each Main plugin group and fails closed on dependency loss', async () => {
  const seen: string[] = [];
  const limit = { options, budgets: rateLimitBudgets(), store: {
    async classify() { return 'member' as const; },
    async consume(_identity: string, family: string) { seen.push(family); return { allowed: false, retryAfter: 31 }; },
  } };
  const work = { rateLimit: limit, mcp: { issuer: 'https://account.test/api/auth', resource: 'http://localhost' },
    account: { async verify() { return { issuer: 'account', subject: 'same' }; } } } as unknown as MainWorkDependencies;
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), work);
  // The guard must be present in every plugin group, including those composed
  // before domainRoutes. Merely testing a standalone plugin misses hook order.
  expect(app.routes.filter(route => rateLimitFamily(route.method, route.path) === undefined)
    .map(route => `${route.method} ${route.path}`)).toEqual([]);
  expect(app.routes.map(route => `${route.method} ${route.path}`)).toEqual(expect.arrayContaining([
    '* /mcp', 'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/mcp',
  ]));
  expect(rateLimitFamily('POST', '/mcp')).toBeNull();
  expect(rateLimitFamily('GET', '/mcp')).toBeNull();
  let guarded = 0;
  for (const route of app.routes) {
    expect(rateLimitFamily(route.method, route.path)).not.toBeUndefined();
    if (rateLimitFamily(route.method, route.path) === null) continue;
    const hooks = (route.hooks.beforeHandle ?? []) as Function[];
    expect(hooks.some(hook => hook.name === 'enforceRateLimit')).toBe(true);
    guarded++;
  }
  expect(guarded).toBeGreaterThan(50);
  const query = await app.handle(new Request('http://localhost/v1/queries', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'public-main-phrase-v1',
      phrase: 'needle', language: null }) }));
  expect(query.status).toBe(429);
  const harness = new Elysia().use(rateLimitHook(work.account, limit)).post('/v1/works', () => 'effect');
  const response = await harness.handle(new Request('http://localhost/v1/works', { method: 'POST' }));
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('31');
  expect(seen).toContain('write');
  const searches = new Elysia().use(rateLimitHook(work.account, limit))
    .post('/v1/queries', () => 'results').post('/v1/query', () => 'results');
  expect((await searches.handle(new Request('http://localhost/v1/query', { method: 'POST' }))).status).toBe(429);
  expect((await searches.handle(new Request('http://localhost/v1/query', { method: 'POST',
    headers: { authorization: 'Bearer verified' } }))).status).toBe(429);
  expect((await searches.handle(new Request('http://localhost/v1/queries', { method: 'POST' }))).status).toBe(429);
  expect((await searches.handle(new Request('http://localhost/v1/queries', { method: 'POST',
    headers: { authorization: 'Bearer verified' } }))).status).toBe(429);
  limit.store.consume = async () => { throw new Error('counter outage'); };
  const outage = await harness.handle(new Request('http://localhost/v1/works', { method: 'POST' }));
  expect(outage.status).toBe(503);
  expect(outage.headers.get('retry-after')).toBe('5');
  for (const [error, status] of [[new AccountAssertionDenied(), 401], [new AccountAssertionUnavailable(), 503]] as const) {
    const failed = new Elysia().use(rateLimitHook({ async verify() { throw error; } }, limit)).post('/v1/works', () => 'effect');
    expect((await failed.handle(new Request('http://localhost/v1/works', { method: 'POST',
      headers: { authorization: 'Bearer test' } }))).status).toBe(status);
  }
});
