import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { AccessGrants } from '../src/modules/access/grants.ts';
import { AccessPlatformAdministrators } from '../src/modules/access/platform-administrator.ts';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionExpired } from '../src/modules/access/admission.ts';
import { deactivateFixtureController, ensureFixtureScopeGate, grantFixtureAuthority,
  reduceFixtureGrant, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import { accessAuthorityRoutes } from '../src/routes/access-authority.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const root = resolve(import.meta.dir, '../../..');
const migration = '2067_realm_attachment_assignment.sql';
const template = 'realm_attachment_assignment_template';
const assignment = 'access.grant.assign.realm.attach';
const permission = 'platform:resource:realm.attach';
const realmScope = `realm:attach:https://rezics.com/id/${randomUUID()}`;
let cluster: PostgresCluster;
let admin: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = new Pool(cluster.connection);
  await admin.query(`CREATE DATABASE ${template}`);
  const pool = new Pool({ ...cluster.connection, database: template });
  try {
    for (const file of schemaFiles(root, 'access')) {
      if (file !== migration) await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
  } finally { await pool.end(); }
}, 60_000);

afterAll(async () => { await admin?.end(); cluster?.remove(); });

async function person(pool: Pool) {
  const id = randomUUID(), actor = `https://rezics.com/id/${randomUUID()}`;
  const principal = { issuer: 'https://account.realm-attachment.test', subject: randomUUID() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await registerFixtureIdentity(client, { principalId: id, actor, ...principal });
    const authority = await grantFixtureAuthority(client, { scope: `agent:control:${actor}`, requireDispatch: true,
      representations: [{ principalId: id, actor, action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor, action: 'agent.control', lifetime: 'infinity' } });
    await client.query('COMMIT');
    return { id, actor, principal, control: authority.representationIds[0]! };
  } finally { client.release(); }
}
type Person = Awaited<ReturnType<typeof person>>;
type Grant = { grant: { id: string; generation: string; active: boolean } };

async function fixture(upgrade = false) {
  const database = `attachment_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database} TEMPLATE ${template}`);
  const pool = new Pool({ ...cluster.connection, database, max: 5 });
  const deployment = await person(pool), operator = await person(pool), ordinary = await person(pool);
  const bootstrap = () => new AccessPlatformAdministrators(pool).designateFirst(
    deployment.principal.issuer, deployment.principal.subject, () => undefined);
  const upgradeSchema = async () => {
    if (schemaFiles(root, 'access').includes(migration))
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', migration), 'utf8'));
  };
  if (!upgrade) await upgradeSchema();
  await bootstrap();
  const people = [deployment, operator, ordinary];
  const app = new Elysia().use(accessAuthorityRoutes({ grants: new AccessGrants(pool), account: {
    verify: async (request: Request) => people.find(p => request.headers.get('authorization') === `Bearer ${p.id}`)!.principal,
  } } as unknown as MainWorkDependencies));
  const epoch = async () => (await pool.query<{ authority_epoch: string }>(
    "SELECT authority_epoch FROM access.scope_gate WHERE id = 'platform:access'")).rows[0]!.authority_epoch;
  const call = async (issuer: Person, body: Record<string, unknown>) => {
    const response = await app.handle(new Request('http://main.test/v1/access/grant-changes', {
      method: 'POST', headers: { authorization: `Bearer ${issuer.id}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'platform-grant-change-v1', issuerSubject: issuer.actor,
        expectedAuthorityEpoch: await epoch(), ...body }),
    }));
    return { status: response.status, body: await response.json() as Grant & { code: string; title: string } };
  };
  const designate = (recipient = operator, options: { issuer?: Person; permission?: string; scope?: string; until?: string | null } = {}) =>
    call(options.issuer ?? deployment, { action: 'create', grantId: randomUUID(),
      permission: options.permission ?? permission, scopeId: options.scope ?? realmScope,
      recipient: { principalId: recipient.id }, validUntil: options.until === undefined
        ? new Date(Date.now() + 60_000).toISOString() : options.until });
  const revoke = (grant: Grant) => call(deployment, { action: 'revoke', grantId: grant.grant.id,
    expectedObjectGeneration: grant.grant.generation });
  const ceiling = async () => (await pool.query<{ id: string }>(`SELECT id FROM access.permission_grant
    WHERE assigned_by_principal = $1 AND action = $2`, [deployment.id, assignment])).rows[0]!.id;
  const access = new AccessAdmissionRegistry(pool);
  const held = async (who = operator, scope = realmScope, action = 'realm.attach') => {
    try { await access.assertAuthority({ principal: who.principal, actingSubject: who.actor, scope, action }); return true; }
    catch (error) {
      if (error instanceof AdmissionDenied || error instanceof AdmissionExpired) return false;
      throw error;
    }
  };
  return { pool, deployment, operator, ordinary, bootstrap, upgradeSchema, designate, revoke, ceiling, held,
    close: async () => { await pool.end(); await admin.query(`DROP DATABASE ${database}`); } };
}

test('fresh bootstrap assigns exact Realm intervention through the public API without implicit intervention', async () => {
  const f = await fixture();
  try {
    expect(await f.held(f.deployment)).toBe(false);
    expect(await f.designate(f.operator, { permission: 'platform:use:platform-admin', scope: 'platform:access' })).toMatchObject({ status: 200 });
    expect(await f.held()).toBe(false);
    expect(await f.designate()).toMatchObject({ status: 200, body: { grant: { active: true } } });
    expect(await f.held()).toBe(true);
    const otherRealm = `realm:attach:${f.ordinary.actor}`, zone = `zone:edit:${f.ordinary.actor}`;
    await ensureFixtureScopeGate(f.pool, otherRealm);
    await ensureFixtureScopeGate(f.pool, zone);
    expect(await f.held(f.operator, otherRealm)).toBe(false);
    expect(await f.held(f.operator, zone, 'zone.edit')).toBe(false);
    expect(await f.held(f.ordinary)).toBe(false);
  } finally { await f.close(); }
});

test('upgrade equips only the original deployment authority, never another administrator or grant holder', async () => {
  const f = await fixture(true);
  try {
    expect(await f.designate()).toMatchObject({ status: 403, body: { code: 'grant_denied',
      title: 'Resource assignment ceiling is missing or shorter' } });
    expect(await f.designate(f.ordinary, { permission: 'platform:grant', scope: 'platform:access', until: null })).toMatchObject({ status: 200 });
    expect(await f.designate(f.ordinary, { permission: 'platform:use:platform-admin', scope: 'platform:access' })).toMatchObject({ status: 200 });
    await f.upgradeSchema();
    expect(await f.designate(f.operator, { issuer: f.ordinary })).toMatchObject({ status: 403, body: { code: 'grant_denied' } });
    expect(await f.designate()).toMatchObject({ status: 200 });
    expect((await f.pool.query('SELECT assigned_by_principal FROM access.permission_grant WHERE action = $1', [assignment])).rows)
      .toEqual([{ assigned_by_principal: f.deployment.id }]);
  } finally { await f.close(); }
});

test('assignment scope and lifetime stay bounded and revoked resource mandates remain revoked', async () => {
  const f = await fixture();
  try {
    expect(await f.designate(f.operator, { scope: `zone:edit:${f.operator.actor}` })).toMatchObject({ status: 403 });
    expect(await f.designate(f.operator, { scope: 'realm:attachments:*' })).toMatchObject({ status: 403 });
    const ceiling = await f.ceiling();
    await reduceFixtureGrant(f.pool, ceiling, { validUntil: new Date(Date.now() + 30_000) });
    expect(await f.designate()).toMatchObject({ status: 403 });
    const grant = await f.designate(f.deployment, { until: new Date(Date.now() + 10_000).toISOString() });
    expect(grant.status).toBe(200);
    expect(await f.held(f.deployment)).toBe(true);
    expect(await f.revoke(grant.body)).toMatchObject({ status: 200 });
    await f.bootstrap();
    expect(await f.held(f.deployment)).toBe(false);
  } finally { await f.close(); }
});

test('repeat bootstrap preserves an expired ceiling rather than widening its lifetime', async () => {
  const f = await fixture();
  try {
    const id = await f.ceiling();
    await reduceFixtureGrant(f.pool, id, { validUntil: new Date(Date.now() - 1_000) });
    await f.bootstrap();
    expect(await f.designate()).toMatchObject({ status: 403 });
    expect((await f.pool.query('SELECT id FROM access.permission_grant WHERE action = $1', [assignment])).rows).toEqual([{ id }]);
  } finally { await f.close(); }
});

test('revoked ceiling cannot be restored by bootstrap or by replacing its deployment controller', async () => {
  const f = await fixture();
  try {
    const id = await f.ceiling();
    await reduceFixtureGrant(f.pool, id, { active: false });
    await f.bootstrap();
    expect(await f.designate()).toMatchObject({ status: 403 });
    await grantFixtureAuthority(f.pool, { scope: `agent:control:${f.ordinary.actor}`, requireDispatch: true,
      representations: [{ principalId: f.deployment.id, actor: f.ordinary.actor, action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor: f.ordinary.actor, action: 'agent.control', lifetime: 'infinity' } });
    await grantFixtureAuthority(f.pool, { scope: `agent:control:${f.deployment.actor}`, requireDispatch: true,
      representations: [{ principalId: f.ordinary.id, actor: f.deployment.actor, action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor: f.deployment.actor, action: 'agent.control', lifetime: 'infinity' } });
    await deactivateFixtureController(f.pool, f.deployment.control);
    await f.bootstrap();
    expect((await f.pool.query('SELECT id,active FROM access.permission_grant WHERE action = $1', [assignment])).rows)
      .toEqual([{ id, active: false }]);
  } finally { await f.close(); }
});

test('upgrade and repeat bootstrap preserve revocation of the original deployment designation', async () => {
  const f = await fixture(true);
  try {
    expect(await f.designate(f.ordinary, { permission: 'platform:grant', scope: 'platform:access', until: null })).toMatchObject({ status: 200 });
    const grant = (await f.pool.query<{ id: string; generation: string }>(`SELECT id,generation::text FROM access.principal_permission_grant
      WHERE principal_id = $1 AND action = 'platform:grant'`, [f.deployment.id])).rows[0]!;
    expect(await f.revoke({ grant: { ...grant, active: true } })).toMatchObject({ status: 200 });
    await f.upgradeSchema();
    await f.bootstrap();
    expect(await f.designate()).toMatchObject({ status: 403 });
    expect((await f.pool.query('SELECT 1 FROM access.permission_grant WHERE action = $1', [assignment])).rowCount).toBe(0);
  } finally { await f.close(); }
});
