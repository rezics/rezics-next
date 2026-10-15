import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { httpTelemetry } from '@rezics/observability/elysia';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { principalClasses, rateLimitBudgets } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { PostgresRateLimitStore, RATE_LIMIT_COST_V1, type RateLimitOptions } from '../src/modules/rate-limit/store.ts';
import type { VerifiedAccountAssertion } from '../src/modules/account/verify-assertion.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { compareMigrationPaths } from '../../../scripts/lib/migration-order.ts';

const options: RateLimitOptions = { secret: 'g543-test-counter-secret-at-least-32-characters',
  serviceClientIds: new Set(['installed-importer']), trustedProxyPeers: new Set(['127.0.0.2']),
  clientIpHeader: 'x-forwarded-for' };

test('PostgreSQL counters enforce all classes, concurrent subject budgets, safety isolation and replay', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 8 });
  try {
    const migrations = join(root, 'services/main/migrations/access');
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort(compareMigrationPaths)) {
      await pool.query(readFileSync(join(migrations, file), 'utf8'));
    }
    const store = new PostgresRateLimitStore(pool, options);
    const issuer = 'https://account.rezics.test';
    const principals = new Map<string, VerifiedAccountAssertion>();
    for (const subject of ['new-account', 'member', 'trusted', 'service']) {
      principals.set(subject, subject === 'service'
        ? { issuer, subject: 'installed-importer', accountClientId: 'installed-importer', accountAuthMode: 'workload' }
        : { issuer, subject, accountClientId: 'reader' });
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
    expect(await store.classify({ issuer, subject: 'member', accountClientId: 'installed-importer', accountAuthMode: 'consent' })).toBe('member');
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
      .post('/v1/public-reports/1/correspondence', () => Response.json({ received: true }))
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
      expect((await send(principal, '/v1/public-reports/1/correspondence')).status).toBe(200);
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
    const network = new Elysia().use(httpTelemetry()).use(rateLimitHook(account, { store, options, budgets }))
      .post('/v1/claims', () => Response.json({ accepted: true }))
      .listen({ hostname: '127.0.0.1', port: 0 });
    try {
      for (let attempt = 0; attempt < 128; attempt++) {
        expect((await fetch(`http://127.0.0.1:${network.server!.port}/v1/claims`, {
          method: 'POST', headers: { 'x-forwarded-for': `198.51.100.${attempt}`,
            'x-rezics-client-ip': `203.0.113.${attempt}` },
        })).status).toBe(attempt < 2 ? 200 : 429);
      }
      const sweepDeadline = Date.now() + 5000;
      while ((await pool.query('SELECT key FROM access.rate_limit_v1 WHERE key = $1', [expiredProbe])).rowCount
        && Date.now() < sweepDeadline) await Bun.sleep(20);
      expect((await pool.query('SELECT key FROM access.rate_limit_v1 WHERE key = $1', [expiredProbe])).rowCount).toBe(0);
      const peerKey = createHmac('sha256', options.secret).update('anonymous:127.0.0.1').digest('hex');
      const retained = await pool.query<{ count: number }>(
        "SELECT count FROM access.rate_limit_v1 WHERE key = $1 AND family = 'write'", [peerKey]);
      expect(retained.rowCount).toBe(1);
      expect(retained.rows[0]!.count).toBe(3);
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
    cluster.remove();
  }
}, 120_000);
