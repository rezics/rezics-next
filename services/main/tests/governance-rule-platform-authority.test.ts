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
import { deactivateFixtureController, ensureFixtureScopeGate, expireFixtureAuthority,
  grantFixtureAuthority, reduceFixtureGrant, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { GovernanceRules, RULE_PUBLISH_ACTION } from '../src/modules/governance/rules.ts';
import { accessAuthorityRoutes } from '../src/routes/access-authority.ts';
import { reportRoutes } from '../src/routes/reports.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const root = resolve(import.meta.dir, '../../..');
const migration = '2066_governance_rule_publisher.sql';
const scope = 'governance:platform';
const permission = `platform:resource:${RULE_PUBLISH_ACTION}`;
const template = 'rule_publisher_template';
let cluster: PostgresCluster;
let admin: Pool;
let expiredController: Person;

beforeAll(async () => {
  // Authority, locking and replay use real SQL transactions; this disposable
  // fixture does not exercise crash durability or need per-write disk flushes.
  cluster = await startPostgresCluster({ serverSettings: 'fsync = off\nsynchronous_commit = off' });
  admin = new Pool(cluster.connection);
  await admin.query(`CREATE DATABASE ${template}`);
  const pool = new Pool({ ...cluster.connection, database: template });
  try {
    for (const file of schemaFiles(root, 'access')) {
      if (file === '054_agent_control.sql') {
        // Upgrade retains finite legacy controllers; their active flag is not a live mandate.
        expiredController = await person(pool);
        await expireFixtureAuthority(pool, expiredController.actor);
      }
      if (file !== migration) await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
  } finally { await pool.end(); }
}, 60_000);

afterAll(async () => {
  await admin?.end();
  cluster?.remove();
});

async function person(pool: Pool) {
  const id = randomUUID(), actor = `https://rezics.com/id/${randomUUID()}`;
  const principal = { issuer: 'https://account.rule-publisher.test', subject: randomUUID() };
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
  const database = `publisher_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database} TEMPLATE ${template}`);
  const pool = new Pool({ ...cluster.connection, database, max: 5 });
  const deployment = await person(pool), publisher = await person(pool), ordinary = await person(pool);
  const bootstrap = () => new AccessPlatformAdministrators(pool).designateFirst(
    deployment.principal.issuer, deployment.principal.subject, () => undefined);
  const upgradeSchema = async () => {
    const path = join(root, 'services/main/migrations/access', migration);
    // The baseline still exercises the public request when this additive migration is absent.
    if (schemaFiles(root, 'access').includes(migration)) await pool.query(readFileSync(path, 'utf8'));
  };
  if (!upgrade) await upgradeSchema();
  await bootstrap();
  const people = [deployment, publisher, ordinary, expiredController];
  const app = new Elysia().use(accessAuthorityRoutes({ grants: new AccessGrants(pool), account: {
    verify: async (request: Request) => people.find(p => request.headers.get('authorization') === `Bearer ${p.id}`)!.principal,
  } } as unknown as MainWorkDependencies)).use(reportRoutes({ governance: { rules: new GovernanceRules(pool) }, account: {
    verify: async (request: Request) => people.find(p => request.headers.get('authorization') === `Bearer ${p.id}`)!.principal,
  } } as unknown as MainWorkDependencies));
  const call = async (who: Person, path: string, body: Record<string, unknown>, key = randomUUID()) => {
    const response = await app.handle(new Request(`http://main.test${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${who.id}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  };
  const epoch = async () => (await pool.query<{ authority_epoch: string }>(
    "SELECT authority_epoch FROM access.scope_gate WHERE id = 'platform:access'" )).rows[0]!.authority_epoch;
  const designate = async (recipient = publisher, options: { issuer?: Person; permission?: string; scope?: string; until?: string | null } = {}) => {
    const issuer = options.issuer ?? deployment;
    return call(issuer, '/v1/access/grant-changes', { profile: 'platform-grant-change-v1',
      issuerSubject: issuer.actor, expectedAuthorityEpoch: await epoch(), action: 'create', grantId: randomUUID(),
      permission: options.permission ?? permission, scopeId: options.scope ?? scope,
      recipient: { principalId: recipient.id }, validUntil: options.until === undefined
        ? new Date(Date.now() + 60_000).toISOString() : options.until });
  };
  const revoke = async (grant: Grant) => call(deployment, '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', issuerSubject: deployment.actor, expectedAuthorityEpoch: await epoch(),
    action: 'revoke', grantId: grant.grant.id, expectedObjectGeneration: grant.grant.generation,
  });
  const ceiling = async () => (await pool.query<{ id: string }>(`SELECT id FROM access.permission_grant
    WHERE recipient_subject = $1 AND action = 'access.grant.assign.governance.rule.publish'`, [deployment.actor])).rows[0]!.id;
  const input = (who = publisher, scopeId = scope) => ({ profile: 'governance-rule-v1',
    ref: `urn:rezics:rule:${randomUUID()}`, scopeId, actingSubject: who.actor, expectedRevision: null as string | null,
    document: { rule: 'Review the exact record while preserving original contributions.' }, idempotencyKey: randomUUID() });
  const publish = (who = publisher, body = input(who)) => call(who, '/v1/governance/rules', body, body.idempotencyKey);
  return { pool, deployment, publisher, ordinary, expiredController, bootstrap, upgradeSchema, designate, revoke, ceiling, input, publish,
    close: async () => { await pool.end(); await admin.query(`DROP DATABASE ${database}`); } };
}

test('public designation authorizes a non-administrator publisher, CAS and replay', async () => {
  const f = await fixture();
  try {
    expect(await f.publish(f.ordinary)).toMatchObject({ status: 403, body: { code: 'governance_denied' } });
    expect(await f.publish(f.deployment)).toMatchObject({ status: 403, body: { code: 'governance_denied' } });
    const designation = await f.designate();
    expect(designation).toMatchObject({ status: 200, body: { grant: { active: true } } });
    const body = f.input(), first = await f.publish(f.publisher, body);
    expect(first).toMatchObject({ status: 201, body: { revision: '1', replayed: false } });
    expect(await f.publish(f.publisher, body)).toMatchObject({ status: 200,
      body: { ...first.body, replayed: true } });
    expect(await f.publish(f.publisher, { ...body, idempotencyKey: randomUUID() }))
      .toMatchObject({ status: 409, body: { code: 'stale_governance_basis' } });
    expect(await f.publish(f.publisher, { ...body, document: { rule: 'Changed intent' } }))
      .toMatchObject({ status: 409, body: { code: 'idempotency_conflict' } });
    expect(await f.publish(f.publisher, { ...body, expectedRevision: '1', idempotencyKey: randomUUID() }))
      .toMatchObject({ status: 201, body: { revision: '2' } });
    expect(await f.publish(f.publisher, { ...f.input(), ref: `urn:rezics:realm-rules:${randomUUID()}` }))
      .toMatchObject({ status: 400, body: { code: 'invalid_governance_request' } });
  } finally { await f.close(); }
});

test('upgrade equips only the original deployment holder and preserves revoked publisher and ceiling', async () => {
  const f = await fixture(true);
  try {
    expect(await f.designate()).toMatchObject({ status: 403, body: { code: 'grant_denied' } });
    expect(await f.designate(f.ordinary, { permission: 'platform:grant', scope: 'platform:access', until: null }))
      .toMatchObject({ status: 200 });
    expect(await f.designate(f.ordinary, { permission: 'platform:use:platform-admin', scope: 'platform:access' }))
      .toMatchObject({ status: 200 });
    await f.upgradeSchema();
    expect(await f.designate(f.publisher, { issuer: f.ordinary })).toMatchObject({ status: 403, body: { code: 'grant_denied' } });
    expect(await f.publish(f.ordinary)).toMatchObject({ status: 403 });
    const designated = await f.designate();
    expect(designated.status).toBe(200);
    const body = f.input();
    expect((await f.publish(f.publisher, body)).status).toBe(201);
    expect((await f.revoke(designated.body)).status).toBe(200);
    await f.bootstrap();
    expect(await f.publish(f.publisher, body)).toMatchObject({ status: 403 });
    expect(await f.publish(f.publisher)).toMatchObject({ status: 403 });
    await reduceFixtureGrant(f.pool, await f.ceiling(), { active: false });
    await f.bootstrap();
    expect(await f.designate()).toMatchObject({ status: 403, body: { code: 'grant_denied' } });
  } finally { await f.close(); }
});

test('resource assignment obeys scope and lifetime ceilings; designation expiry also fences replay', async () => {
  const f = await fixture();
  try {
    expect(await f.designate(f.publisher, { scope: `governance:realm:${f.ordinary.actor}` }))
      .toMatchObject({ status: 403, body: { code: 'grant_denied' } });
    await reduceFixtureGrant(f.pool, await f.ceiling(), { validUntil: new Date(Date.now() + 10_000) });
    await reduceFixtureGrant(f.pool, await f.ceiling(), { validUntil: new Date(Date.now() + 60_000) });
    expect(await f.designate()).toMatchObject({ status: 403, body: { code: 'grant_denied' } });
    expect(await f.designate(f.publisher, { until: new Date(Date.now() + 500).toISOString() })).toMatchObject({ status: 200 });
    const body = f.input();
    expect((await f.publish(f.publisher, body)).status).toBe(201);
    expect(await f.publish(f.publisher, f.input(f.publisher, `governance:realm:${f.ordinary.actor}`)))
      .toMatchObject({ status: 403, body: { code: 'governance_denied' } });
    await f.pool.query('SELECT pg_sleep(0.6)');
    expect(await f.publish(f.publisher, body)).toMatchObject({ status: 403, body: { code: 'governance_denied' } });
    expect(await f.publish()).toMatchObject({ status: 403 });
  } finally { await f.close(); }
});

for (const state of ['principal', 'subject', 'controller', 'resource-gate', 'platform-gate', 'dispatch', 'recovery'] as const) {
  test(`live ${state} fences publication and replay`, async () => {
    const f = await fixture();
    try {
      expect((await f.designate()).status).toBe(200);
      const body = f.input();
      expect((await f.publish(f.publisher, body)).status).toBe(201);
      if (state === 'principal') await f.pool.query('UPDATE access.principal SET active = false WHERE id = $1', [f.publisher.id]);
      if (state === 'subject') await f.pool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [f.publisher.actor]);
      if (state === 'controller') {
        await grantFixtureAuthority(f.pool, { scope: `agent:control:${f.publisher.actor}`, requireDispatch: true,
          representations: [{ principalId: f.ordinary.id, actor: f.publisher.actor, action: 'agent.control', lifetime: 'infinity' }],
          grant: { actor: f.publisher.actor, action: 'agent.control', lifetime: 'infinity' } });
        await deactivateFixtureController(f.pool, f.publisher.control);
        // An unrelated live representation must not substitute for the lost controller.
        await grantFixtureAuthority(f.pool, { scope: `governance:realm:${f.publisher.actor}`, requireDispatch: true,
          representations: [{ principalId: f.publisher.id, actor: f.publisher.actor, action: RULE_PUBLISH_ACTION, lifetime: 'infinity' }],
          grant: { actor: f.publisher.actor, action: RULE_PUBLISH_ACTION, lifetime: 'infinity' } });
      }
      if (state === 'resource-gate' || state === 'platform-gate') await ensureFixtureScopeGate(f.pool,
        state === 'resource-gate' ? scope : 'platform:access', { open: false });
      if (state === 'dispatch') {
        const gate = (await f.pool.query<{ authority_epoch: string }>('SELECT authority_epoch FROM access.scope_gate WHERE id = $1', [scope])).rows[0]!;
        await new AccessAdmissionRegistry(f.pool).strongCloseScope(scope, gate.authority_epoch);
      }
      if (state === 'recovery') await f.pool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
      const status = state === 'recovery' ? 503 : 403;
      expect((await f.publish(f.publisher, body)).status).toBe(status);
      expect((await f.publish()).status).toBe(status);
    } finally { await f.close(); }
  });
}

test('a designated principal with an expired legacy controller cannot publish', async () => {
  const f = await fixture();
  try {
    expect((await f.designate(f.expiredController)).status).toBe(200);
    expect(await f.publish(f.expiredController)).toMatchObject({ status: 403, body: { code: 'governance_denied' } });
  } finally { await f.close(); }
});

test('upgrade and repeat bootstrap preserve revocation of the original deployment designation', async () => {
  const f = await fixture(true);
  try {
    // Access keeps a permanent grant holder before the first holder can leave.
    expect((await f.designate(f.ordinary, { permission: 'platform:grant', scope: 'platform:access', until: null })).status).toBe(200);
    const original = (await f.pool.query<{ id: string; generation: string }>(`SELECT id,generation::text
      FROM access.principal_permission_grant WHERE principal_id = $1 AND action = 'platform:grant'`, [f.deployment.id])).rows[0]!;
    expect((await f.revoke({ grant: { ...original, active: true } })).status).toBe(200);
    await f.upgradeSchema();
    await f.bootstrap();
    expect(await f.designate()).toMatchObject({ status: 403, body: { code: 'grant_denied' } });
    expect((await f.pool.query(`SELECT 1 FROM access.permission_grant
      WHERE action = 'access.grant.assign.governance.rule.publish'`)).rowCount).toBe(0);
  } finally { await f.close(); }
});

test('ordinary scoped publication retains its grant and managed-settings restriction', async () => {
  const f = await fixture();
  try {
    const ordinaryScope = `governance:realm:${f.ordinary.actor}`;
    await grantFixtureAuthority(f.pool, { scope: ordinaryScope, requireDispatch: true,
      representations: [{ principalId: f.ordinary.id, actor: f.ordinary.actor, action: RULE_PUBLISH_ACTION, lifetime: 'infinity' }],
      grant: { actor: f.ordinary.actor, action: RULE_PUBLISH_ACTION, lifetime: 'infinity' } });
    const body = f.input(f.ordinary, ordinaryScope);
    expect((await f.publish(f.ordinary, body)).status).toBe(201);
    expect((await f.publish(f.ordinary, body)).status).toBe(200);
    expect(await f.publish(f.ordinary, { ...body, ref: `urn:rezics:realm-rules:${randomUUID()}`, idempotencyKey: randomUUID() }))
      .toMatchObject({ status: 400, body: { code: 'invalid_governance_request' } });
    expect((await f.publish(f.ordinary)).status).toBe(403);
  } finally { await f.close(); }
});
