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

const options: RateLimitOptions = { secret: 'g543-test-counter-secret-at-least-32-characters',
  serviceClientIds: new Set(['installed-importer']), trustedProxyPeers: new Set(['127.0.0.2']),
  clientIpHeader: 'x-forwarded-for' };

test('G-543: every generated mutation has a family and path boundaries protect safety budgets', () => {
  const spec = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../generated/openapi/main/public.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  let mutations = 0;
  for (const [path, methods] of Object.entries(spec.paths)) for (const method of Object.keys(methods)) {
    if (['get', 'head', 'options', 'parameters'].includes(method)) continue;
    expect(rateLimitFamily(method.toUpperCase(), path)).not.toBeNull();
    mutations++;
  }
  expect(mutations).toBeGreaterThan(50);
  expect(rateLimitFamily('GET', '/v1/works')).toBeNull();
  expect(rateLimitFamily('GET', '/v1/search')).toBe('search');
  expect(rateLimitFamily('HEAD', '/v1/search')).toBe('search');
  expect(rateLimitFamily('POST', '/v1/queries/page')).toBe('search');
  expect(rateLimitFamily('POST', '/v1/media/uploads/123')).toBe('upload');
  expect(rateLimitFamily('POST', '/v1/media/uploads-evil')).toBe('write');
  expect(rateLimitFamily('POST', '/v1/public-reports')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/appeals')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/rights/complaints')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/public-reports/123/correspondence')).toBe('correspondence');
  expect(rateLimitFamily('POST', '/v1/cases/123/messages')).toBe('correspondence');
  expect(() => rateLimitBudgets('{"member":{"write":{"maximum":0,"seconds":60}}}')).toThrow();
  expect(() => rateLimitBudgets('{"service":{"wriet":{"maximum":1,"seconds":60}}}')).toThrow();
});

test('G-543: untrusted peers cannot rotate anonymous identities with forwarded headers', () => {
  const request = (ip: string) => new Request('http://localhost/v1/public-reports', { headers: { 'x-forwarded-for': ip } });
  expect(anonymousIdentity(request('1.1.1.1'), '127.0.0.1', options))
    .toBe(anonymousIdentity(request('2.2.2.2'), '127.0.0.1', options));
  expect(anonymousIdentity(request('1.1.1.1'), '127.0.0.2', options)).toBe('anonymous:1.1.1.1');
  expect(anonymousIdentity(request('1.1.1.1, 2.2.2.2'), '127.0.0.2', options)).toBe('anonymous:127.0.0.2');
  expect(anonymousIdentity(request('1.1.1.1'), undefined, options)).toBe('anonymous:unknown');
});

test('G-543: global hook reaches each Main plugin group and fails closed on dependency loss', async () => {
  const seen: string[] = [];
  const limit = { options, budgets: rateLimitBudgets(), store: {
    async classify() { return 'member' as const; },
    async consume(_identity: string, family: string) { seen.push(family); return { allowed: false, retryAfter: 31 }; },
  } };
  const work = { rateLimit: limit, account: { async verify() { return { issuer: 'account', subject: 'same' }; } } } as unknown as MainWorkDependencies;
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), work);
  // The guard must be present in every plugin group, including those composed
  // before domainRoutes. Merely testing a standalone plugin misses hook order.
  let guarded = 0;
  for (const route of app.routes) {
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
  const harness = new Elysia().use(rateLimitHook(work.account, limit)).post('/v1/test', () => 'effect');
  const response = await harness.handle(new Request('http://localhost/v1/test', { method: 'POST' }));
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('31');
  expect(seen).toContain('write');
  const searches = new Elysia().use(rateLimitHook(work.account, limit)).post('/v1/queries', () => 'results');
  expect((await searches.handle(new Request('http://localhost/v1/queries', { method: 'POST' }))).status).toBe(429);
  expect((await searches.handle(new Request('http://localhost/v1/queries', { method: 'POST',
    headers: { authorization: 'Bearer verified' } }))).status).toBe(200);
  limit.store.consume = async () => { throw new Error('counter outage'); };
  const outage = await harness.handle(new Request('http://localhost/v1/test', { method: 'POST' }));
  expect(outage.status).toBe(503);
  expect(outage.headers.get('retry-after')).toBe('5');
  for (const [error, status] of [[new AccountAssertionDenied(), 401], [new AccountAssertionUnavailable(), 503]] as const) {
    const failed = new Elysia().use(rateLimitHook({ async verify() { throw error; } }, limit)).post('/v1/test', () => 'effect');
    expect((await failed.handle(new Request('http://localhost/v1/test', { method: 'POST',
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
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort()) {
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
      .post('/v1/test', () => Response.json({ received: true }))
      .post('/v1/admissions-test', async ({ request }) => Response.json(await registry.register({
        principal: principals.get('member')!, actingSubject: agent, scope: 'work:create:root', action: 'work.create',
        idempotencyKey: request.headers.get('idempotency-key')!, requestDigest: 'a'.repeat(64),
      })))
      .post('/v1/public-reports', () => Response.json({ received: true }))
      .post('/v1/appeals', () => Response.json({ received: true }))
      .post('/v1/cases/1/messages', () => Response.json({ received: true }))
      .post('/v1/media/uploads', () => Response.json({ created: true }));
    const send = (subject: string, path = '/v1/test', key?: string, token = 1) => app.handle(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { ...(subject === 'anonymous' ? {} : { authorization: `Bearer ${subject}-token-${token}` }),
        ...(key ? { 'idempotency-key': key } : {}) },
    }));
    for (const principal of principalClasses) {
      expect((await send(principal, '/v1/test', `effect-${principal}`)).status).toBe(200);
      expect((await send(principal, '/v1/test', `second-${principal}`, 2)).status).toBe(200);
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
    expect((await send('member', '/v1/admissions-test', 'admitted-member')).status).toBe(200);
    expect((await send('member')).status).toBe(200);
    expect((await send('member', '/v1/admissions-test', 'admitted-member', 2)).status).toBe(429);
    await pool.query("UPDATE access.rate_limit_v1 SET expires_at = now() - interval '1 second' WHERE family = 'write'");
    const replay = await send('member', '/v1/admissions-test', 'admitted-member', 2);
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
    const network = new Elysia().use(rateLimitHook(account, { store, options, budgets }))
      .post('/v1/network-test', () => Response.json({ accepted: true }))
      .listen({ hostname: '127.0.0.1', port: 0 });
    try {
      for (const [ip, status] of [['1.1.1.1', 200], ['2.2.2.2', 200], ['3.3.3.3', 429]] as const) {
        expect((await fetch(`http://127.0.0.1:${network.server!.port}/v1/network-test`, {
          method: 'POST', headers: { 'x-forwarded-for': ip },
        })).status).toBe(status);
      }
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
      SELECT lpad(to_hex(n),64,'0'),'search',1,now() - interval '1 day' FROM generate_series(1,1000) n`);
    const expiredBefore = Number((await pool.query<{ count: string }>("SELECT count(*) FROM access.rate_limit_v1 WHERE family = 'search' AND expires_at < now()")).rows[0]!.count);
    await store.consume('expiry-probe', 'write', { maximum: 2, seconds: 60 });
    const expiredAfter = Number((await pool.query<{ count: string }>("SELECT count(*) FROM access.rate_limit_v1 WHERE family = 'search' AND expires_at < now()")).rows[0]!.count);
    expect(expiredBefore - expiredAfter).toBeGreaterThan(0);
    expect(expiredBefore - expiredAfter).toBeLessThanOrEqual(RATE_LIMIT_COST_V1.expiryRows);
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
