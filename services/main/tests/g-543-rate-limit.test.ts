import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { freePort } from '../../account/tests/account-fixture.ts';
import { rateLimitBudgets, rateLimitFamily, principalClasses } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { anonymousIdentity, PostgresRateLimitStore, RATE_LIMIT_COST_V1, type RateLimitOptions } from '../src/modules/rate-limit/store.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable, type VerifiedAccountAssertion } from '../src/modules/account/verify-assertion.ts';
import { createMainApp } from '../src/app.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { mainRequestHeaders } from '../../../apps/web/features/api/bff.ts';
import { PrincipalBudgetCache } from '../src/modules/rate-limit/principal-cache.ts';
import { appEnvironment } from '../../../scripts/dev/config.ts';
import { compareMigrationPaths } from '../../../scripts/lib/migration-order.ts';
import { ReaderLibraryImportStore } from '../src/modules/library-import/reader-import.ts';

const options: RateLimitOptions = { secret: 'g543-test-counter-secret-at-least-32-characters',
  serviceClientIds: new Set(['installed-importer']), trustedProxyPeers: new Set(['127.0.0.2']),
  clientIpHeader: 'x-forwarded-for' };

test('G-543: every generated operation has an explicit policy and path boundaries protect safety budgets', () => {
  const spec = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../generated/openapi/main/public.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  let mutations = 0;
  const missing: string[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) for (const method of Object.keys(methods)) {
    if (method === 'parameters') continue;
    if (rateLimitFamily(method.toUpperCase(), path) === undefined) missing.push(`${method.toUpperCase()} ${path}`);
    mutations++;
  }
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
  expect(rateLimitFamily('POST', '/v1/queries')).toBe('search');
  expect(rateLimitFamily('POST', '/v1/queries/page')).toBe('search');
  expect(rateLimitFamily('PUT', '/v1/media/uploads/123/bytes')).toBe('upload');
  expect(rateLimitFamily('POST', '/v1/media/uploads-evil')).toBeUndefined();
  expect(rateLimitFamily('POST', '/v1/public-reports')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/appeals')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/rights/complaints')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/public-reports/123/correspondence')).toBe('correspondence');
  expect(rateLimitFamily('POST', '/v1/cases/123/messages')).toBe('correspondence');
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
      .post('/v1/public-reports', () => 'received').post('/v1/appeals', () => 'received')
      .post('/v1/subscriptions/settlements', () => 'signed callback')
      .post('/v1/new-unclassified-operation', () => 'effect');
    for (const path of ['/v1/resources/summaries', '/v1/public-reports', '/v1/appeals',
      '/v1/subscriptions/settlements']) {
      expect((await app.handle(new Request(`http://localhost${path}`, { method: 'POST',
        headers: { authorization: 'Bearer rejected' } }))).status).toBe(200);
    }
    expect((await app.handle(new Request('http://localhost/v1/new-unclassified-operation', { method: 'POST' }))).status).toBe(503);
  }
  expect(verifications).toBe(0);
  expect(seen.every(entry => entry.family === 'report' || entry.family === 'provider')).toBe(true);
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
    headers: { authorization: 'Bearer verified' } }))).status).toBe(200);
  expect((await searches.handle(new Request('http://localhost/v1/queries', { method: 'POST' }))).status).toBe(429);
  expect((await searches.handle(new Request('http://localhost/v1/queries', { method: 'POST',
    headers: { authorization: 'Bearer verified' } }))).status).toBe(200);
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

test('G-543: PostgreSQL counters enforce all classes, concurrent subject budgets, safety isolation and replay', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const state = join(root, '.temp', `g-543-${Bun.randomUUIDv7()}`);
  const data = join(state, 'pg');
  mkdirSync(state, { recursive: true });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { stdio: 'ignore' });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k /tmp`, '-w', 'start'], { stdio: 'ignore' });
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 8 });
  try {
    const migrations = join(root, 'services/main/migrations/access');
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort(compareMigrationPaths)) {
      await pool.query(readFileSync(join(migrations, file), 'utf8'));
    }
    const store = new PostgresRateLimitStore(pool, options);
    const issuer = 'https://account.rezics.test';
    const principals = new Map<string, VerifiedAccountAssertion>();
    for (const subject of ['new-account', 'member', 'trusted', 'service']) {
      principals.set(subject, { issuer, subject, accountClientId: subject === 'service' ? 'installed-importer' : 'reader' });
      await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject, first_seen_at)
        VALUES ($1, $2, $3, now() - $4 * interval '1 day')`, [Bun.randomUUIDv7(), issuer, subject, subject === 'new-account' ? 0 : 8]);
    }
    const trustedId = (await pool.query<{ id: string }>(`SELECT id FROM access.principal WHERE account_subject = 'trusted'`)).rows[0]!.id;
    const agent = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const familyId = Bun.randomUUIDv7();
    await pool.query(`INSERT INTO access.authority_subject(id, kind) VALUES ($1, 'agent')`, [agent]);
    await pool.query(`INSERT INTO access.representation(id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`, [Bun.randomUUIDv7(), trustedId, agent]);
    await pool.query("INSERT INTO access.scope_gate(id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO access.role_family(id, owner_subject, scope_id, head_revision)
        VALUES ($1,$2,'work:create:root',1)`, [familyId, agent]);
      await client.query(`INSERT INTO access.role_revision(family_id, revision, permissions) VALUES ($1,1,ARRAY['work.create'])`, [familyId]);
      await client.query('COMMIT');
    } finally { client.release(); }
    await pool.query(`INSERT INTO access.role_binding(id, family_id, role_revision, issuer_subject, recipient_subject, valid_until, assigned_by_principal)
      VALUES ($1,$2,1,$3,$3,now() + interval '1 hour',$4)`, [Bun.randomUUIDv7(), familyId, agent, trustedId]);
    for (const [subject, principal] of principals) expect(String(await store.classify(principal))).toBe(subject);
    expect(await store.classify({ issuer, subject: 'unseen' })).toBe('new-account');
    expect(await store.classify({ issuer, subject: 'unseen', accountClientId: 'spoofed-importer' })).toBe('new-account');
    const budgets = rateLimitBudgets(JSON.stringify(Object.fromEntries(principalClasses.map(principal => [principal,
      { write: { maximum: 2, seconds: 60 } }]))));
    const account = { async verify(request: Request) {
      const token = request.headers.get('authorization')!.slice(7).replace(/-token-[12]$/, '');
      return principals.get(token)!;
    } };
    const registry = new AccessAdmissionRegistry(pool);
    const memberId = (await pool.query<{ id: string }>("SELECT id FROM access.principal WHERE account_subject = 'member'")).rows[0]!.id;
    const app = new Elysia().use(rateLimitHook(account, { store, options, budgets }))
      .post('/v1/works', () => Response.json({ received: true }))
      .post('/v1/agents', async ({ request }) => Response.json(await registry.register({
        principal: principals.get('member')!, actingSubject: agent, scope: 'work:create:root', action: 'work.create',
        idempotencyKey: request.headers.get('idempotency-key')!, requestDigest: 'a'.repeat(64),
      })))
      .post('/v1/public-reports', () => Response.json({ received: true }))
      .post('/v1/appeals', () => Response.json({ received: true }))
      .post('/v1/cases/1/messages', () => Response.json({ received: true }))
      .post('/v1/media/uploads', () => Response.json({ created: true }));
    const send = (subject: string, path = '/v1/works', key?: string, token = 1) => app.handle(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { ...(subject === 'anonymous' ? {} : { authorization: `Bearer ${subject}-token-${token}` }),
        ...(key ? { 'idempotency-key': key } : {}) },
    }));
    for (const principal of principalClasses) {
      expect((await send(principal, '/v1/works', `effect-${principal}`)).status).toBe(200);
      expect((await send(principal, '/v1/works', `second-${principal}`, 2)).status).toBe(200);
      const exhausted = await send(principal);
      expect(exhausted.status).toBe(429);
      expect(Number(exhausted.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await send(principal, '/v1/public-reports')).status).toBe(200);
      expect((await send(principal, '/v1/appeals')).status).toBe(200);
      expect((await send(principal, '/v1/cases/1/messages')).status).toBe(200);
    }
    for (let i = 0; i < 5; i++) expect((await send('new-account', '/v1/media/uploads')).status).toBe(200);
    expect((await send('new-account', '/v1/media/uploads')).status).toBe(429);
    for (let i = 0; i < 30; i++) expect((await send('member', '/v1/media/uploads')).status).toBe(200);
    expect((await send('member', '/v1/media/uploads')).status).toBe(429);
    const concurrent = await Promise.all(Array.from({ length: 40 }, () => store.consume('concurrent', 'write', { maximum: 7, seconds: 60 })));
    expect(concurrent.filter(result => result.allowed)).toHaveLength(7);
    // A demotion must not truncate the spent count. Re-gaining the old role
    // or switching back to an installed client cannot refill its window.
    for (let i = 0; i < 3; i++) expect((await store.consume('changing-class', 'write', { maximum: 3, seconds: 60 })).allowed).toBe(true);
    expect((await store.consume('changing-class', 'write', { maximum: 3, seconds: 60 })).allowed).toBe(false);
    expect((await store.consume('changing-class', 'write', { maximum: 1, seconds: 60 })).allowed).toBe(false);
    expect((await store.consume('changing-class', 'write', { maximum: 3, seconds: 60 })).allowed).toBe(false);
    // A retry refused with 429 has no effect; after reset the existing
    // idempotency boundary returns the original effect once.
    await pool.query(`INSERT INTO access.representation(id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`, [Bun.randomUUIDv7(), memberId, agent]);
    await pool.query(`INSERT INTO access.permission_grant(id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','work.create',now() + interval '1 hour')`, [Bun.randomUUIDv7(), agent]);
    await pool.query("UPDATE access.rate_limit_v1 SET expires_at = now() - interval '1 second' WHERE family = 'write'");
    expect((await send('member', '/v1/agents', 'admitted-member')).status).toBe(200);
    expect((await send('member')).status).toBe(200);
    expect((await send('member', '/v1/agents', 'admitted-member', 2)).status).toBe(429);
    await pool.query("UPDATE access.rate_limit_v1 SET expires_at = now() - interval '1 second' WHERE family = 'write'");
    const replay = await send('member', '/v1/agents', 'admitted-member', 2);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { replayed: boolean }).replayed).toBe(true);
    expect((await pool.query("SELECT admission_id FROM access.admission_receipt WHERE idempotency_key = 'admitted-member'")).rowCount).toBe(1);
    await pool.query("UPDATE access.representation SET valid_until = now() - interval '1 second' WHERE principal_id = $1", [trustedId]);
    expect(await store.classify(principals.get('trusted')!)).toBe('member');
    await pool.query(`INSERT INTO access.representation(id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`, [Bun.randomUUIDv7(), trustedId, agent]);
    expect(await store.classify(principals.get('trusted')!)).toBe('trusted');
    await pool.query("UPDATE access.role_binding SET active = false WHERE family_id = $1", [familyId]);
    expect(await store.classify(principals.get('trusted')!)).toBe('member');
    // Compatibility with migration 870's catalogue editor vocabulary. This
    // fixture also runs on the worker's older dispatch schema before rebase.
    await pool.query(`ALTER TABLE access.role_revision DROP CONSTRAINT role_revision_permissions_check;
      ALTER TABLE access.role_revision ADD CONSTRAINT role_revision_permissions_check CHECK (
        cardinality(permissions) <= 2 AND permissions <@ ARRAY['work.create','work.edit']::text[])`);
    const editorFamily = Bun.randomUUIDv7();
    const editorScope = 'work:create:root';
    const editorClient = await pool.connect();
    try {
      await editorClient.query('BEGIN');
      await editorClient.query(`INSERT INTO access.role_family(id,owner_subject,scope_id,head_revision)
        VALUES ($1,$2,$3,1)`, [editorFamily, agent, editorScope]);
      await editorClient.query(`INSERT INTO access.role_revision(family_id,revision,permissions)
        VALUES ($1,1,ARRAY['work.edit'])`, [editorFamily]);
      await editorClient.query('COMMIT');
    } finally { editorClient.release(); }
    await pool.query(`INSERT INTO access.role_binding(id,family_id,role_revision,issuer_subject,recipient_subject,valid_until,assigned_by_principal)
      VALUES ($1,$2,1,$3,$3,now() + interval '1 hour',$4)`, [Bun.randomUUIDv7(), editorFamily, agent, trustedId]);
    expect(await store.classify(principals.get('trusted')!)).toBe('member');
    await pool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.edit',now() + interval '1 hour')`, [Bun.randomUUIDv7(), trustedId, agent]);
    expect(await store.classify(principals.get('trusted')!)).toBe('trusted');
    await pool.query('UPDATE access.scope_gate SET open = false WHERE id = $1', [editorScope]);
    expect(await store.classify(principals.get('trusted')!)).toBe('member');
    // Moderator bundles use current Access grants, never a display role name.
    const realm = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const moderatorRole = Bun.randomUUIDv7();
    const moderatorGrant = Bun.randomUUIDv7();
    await pool.query('INSERT INTO access.realm_admin_revision(realm) VALUES ($1)', [realm]);
    await pool.query(`INSERT INTO access.realm_admin_role(realm,id,name,permissions)
      VALUES ($1,$2,'Renamed role',ARRAY['governance.moderate'])`, [realm, moderatorRole]);
    await pool.query(`INSERT INTO access.realm_admin_assignment(realm,role_id,member,valid_until)
      VALUES ($1,$2,$3,now() + interval '1 hour')`, [realm, moderatorRole, agent]);
    await pool.query('INSERT INTO access.scope_gate(id) VALUES ($1)', [`governance:moderate:${realm}`]);
    await pool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'governance.moderate',now() + interval '1 hour')`, [moderatorGrant, agent, `governance:moderate:${realm}`]);
    await pool.query(`INSERT INTO access.realm_admin_role_grant(realm,role_id,member,grant_id)
      VALUES ($1,$2,$3,$4)`, [realm, moderatorRole, agent, moderatorGrant]);
    // A work.create representation alone cannot borrow an Agent's moderator role.
    expect(await store.classify(principals.get('trusted')!)).toBe('member');
    await pool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'governance.moderate',now() + interval '1 hour')`, [Bun.randomUUIDv7(), trustedId, agent]);
    expect(await store.classify(principals.get('trusted')!)).toBe('trusted');
    await pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [moderatorGrant]);
    expect(await store.classify(principals.get('trusted')!)).toBe('member');
    // Exercise the real peer address supplied by Bun, as well as the pure
    // identity helper: caller-controlled XFF cannot rotate a live HTTP budget.
    const expiredProbe = '0'.repeat(64);
    await pool.query(`INSERT INTO access.rate_limit_v1(key,family,count,expires_at)
      VALUES ($1,'provider',1,now() - interval '1 day')`, [expiredProbe]);
    const network = new Elysia().use(rateLimitHook(account, { store, options, budgets }))
      .post('/v1/claims', () => Response.json({ accepted: true }))
      .listen({ hostname: '127.0.0.1', port: 0 });
    try {
      for (const [ip, status] of [['1.1.1.1', 200], ['2.2.2.2', 200], ['3.3.3.3', 429]] as const) {
        expect((await fetch(`http://127.0.0.1:${network.server!.port}/v1/claims`, {
          method: 'POST', headers: { 'x-forwarded-for': ip },
        })).status).toBe(status);
      }
      const sweepDeadline = Date.now() + 5000;
      while ((await pool.query('SELECT key FROM access.rate_limit_v1 WHERE key = $1', [expiredProbe])).rowCount
        && Date.now() < sweepDeadline) await Bun.sleep(20);
      expect((await pool.query('SELECT key FROM access.rate_limit_v1 WHERE key = $1', [expiredProbe])).rowCount).toBe(0);
      const peerKey = createHmac('sha256', options.secret).update('anonymous:127.0.0.1').digest('hex');
      expect((await pool.query("SELECT count FROM access.rate_limit_v1 WHERE key = $1 AND family = 'write'", [peerKey])).rowCount).toBe(1);
    } finally { await network.stop(true); }
    // Growing authority inventory cannot cause an unbounded role walk or a
    // guessed trust upgrade. The API reports unavailable when its proof bound
    // is exceeded, before consuming a counter or performing an owner effect.
    const overflowId = Bun.randomUUIDv7();
    const overflowAgents = Array.from({ length: RATE_LIMIT_COST_V1.representations + 1 },
      () => `https://rezics.com/id/${Bun.randomUUIDv7()}`);
    await pool.query(`INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,'overflow')`, [overflowId, issuer]);
    await pool.query(`INSERT INTO access.authority_subject(id,kind) SELECT a,'agent' FROM unnest($1::text[]) a`, [overflowAgents]);
    await pool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      SELECT gen_random_uuid(),$2,a,'work.create',now() + interval '1 hour' FROM unnest($1::text[]) a`, [overflowAgents, overflowId]);
    principals.set('overflow', { issuer, subject: 'overflow' });
    await expect(store.classify(principals.get('overflow')!)).rejects.toThrow('representation budget');
    expect((await send('overflow')).status).toBe(503);
    // Expiry work stays bounded even when the stored population grows.
    await pool.query(`INSERT INTO access.rate_limit_v1(key,family,count,expires_at)
      SELECT lpad(to_hex(n),64,'0'),'search',1,now() - interval '1 day' FROM generate_series(1,1005) n`);
    const expiredBefore = Number((await pool.query<{ count: string }>("SELECT count(*) FROM access.rate_limit_v1 WHERE family = 'search' AND expires_at < now()")).rows[0]!.count);
    await store.consume('expiry-probe', 'write', { maximum: 2, seconds: 60 });
    const expiredAfter = Number((await pool.query<{ count: string }>("SELECT count(*) FROM access.rate_limit_v1 WHERE family = 'search' AND expires_at < now()")).rows[0]!.count);
    expect(expiredAfter).toBe(expiredBefore); // Request does no cleanup operation.
    expect(await store.sweepExpired()).toBe(RATE_LIMIT_COST_V1.expirySweepRows);
    expect(Number((await pool.query("SELECT count(*) FROM access.rate_limit_v1 WHERE family = 'search' AND expires_at < now()")).rows[0].count))
      .toBe(expiredBefore - RATE_LIMIT_COST_V1.expirySweepRows);
    expect(await store.sweepExpired()).toBeGreaterThanOrEqual(5);
    expect((await pool.query("SELECT key FROM access.rate_limit_v1 WHERE expires_at <= now()")).rowCount).toBe(0);
    expect((await pool.query("SELECT key FROM access.rate_limit_v1 WHERE expires_at > now()")).rowCount).toBeGreaterThan(0);
    expect(RATE_LIMIT_COST_V1.counterQueries).toBe(1);
    const persisted = await pool.query<{ key: string }>('SELECT key FROM access.rate_limit_v1');
    expect(persisted.rows.every(row => /^[0-9a-f]{64}$/.test(row.key))).toBe(true);
    await pool.query('DROP TABLE access.rate_limit_v1');
    const outage = await send('member');
    expect(outage.status).toBe(503);
    expect(outage.headers.get('retry-after')).toBe('5');
  } finally {
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
