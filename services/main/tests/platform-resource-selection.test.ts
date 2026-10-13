import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { AccessGrants } from '../src/modules/access/grants.ts';
import { grantFixtureAuthority, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';
import {
  AccessPlatformAdministrators,
  platformAdministratorProof,
  platformAdministratorProofCurrent,
  platformAdministratorTargetAllowed,
} from '../src/modules/access/platform-administrator.ts';
import {
  findPlatformPermission,
  readPlatformPermissions,
  type PlatformPermission,
} from '../src/modules/access/platform-permissions.ts';

const zone = `https://rezics.com/id/${randomUUID()}`;
const scope = `zone:edit:${zone}`;
const action = 'platform:resource:zone.edit';
const permission = (scope_id: string, permissionAction = action): PlatformPermission => ({
  id: randomUUID(), action: permissionAction, scope_id, generation: '1',
  valid_until: null, witness: 'live-grant',
});

test('exact resource mandates win in either grant order without changing designation selection', () => {
  const wildcard = permission('zone:edit:*');
  const exact = permission(scope);
  const wrongScope = permission(`zone:edit:${randomUUID()}`);
  const wrongAction = permission(scope, 'platform:resource:zone.official');
  for (const rows of [[wildcard, wrongScope, wrongAction, exact], [exact, wrongAction, wrongScope, wildcard]]) {
    expect(findPlatformPermission(rows, action, scope)).toBe(exact);
  }
  expect(findPlatformPermission([wrongScope, wrongAction], action, scope)).toBeNull();
  expect(findPlatformPermission([wrongScope, wildcard], action, scope)).toBe(wildcard);
  for (const designation of ['platform:grant', 'platform:use:platform-admin']) {
    const first = permission('first-scope', designation);
    const later = permission('platform:access', designation);
    expect(findPlatformPermission([first, later], designation)).toBe(first);
  }
});

test('all administrator resource actions retain exact mandates beside their wildcard', () => {
  for (const [resourceAction, prefix] of [
    ['semantic.read', 'semantic:read'],
    ['semantic.change', 'semantic:edit'],
    ['rating.question-presentation.change', 'rating:presentation'],
    ['zone.official', 'zone:official'],
    ['media.labels.protect', 'media:protect'],
  ]) {
    const permissionAction = `platform:resource:${resourceAction}`;
    const target = `${prefix}:${zone}`;
    const exact = permission(target, permissionAction);
    const wildcard = permission(`${prefix}:*`, permissionAction);
    expect(findPlatformPermission([wildcard, exact], permissionAction, target)).toBe(exact);
    expect(findPlatformPermission([exact, wildcard], permissionAction, target)).toBe(exact);
  }
});

let cluster: PostgresCluster | undefined;
let pool: Pool;
let grants: AccessGrants;
const principalId = randomUUID();
const actor = `https://rezics.com/id/${randomUUID()}`;
const principal = { issuer: 'https://account.resource.test', subject: randomUUID(), emailVerified: true };
const receipt = () => ({ idempotencyKey: randomUUID(),
  requestDigest: createHash('sha256').update(randomUUID()).digest('hex') });
const context = async () => ({ principal, issuerSubject: actor,
  expectedAuthorityEpoch: (await pool.query<{ authority_epoch: string }>(
    "SELECT authority_epoch FROM access.scope_gate WHERE id = 'platform:access'",
  )).rows[0]!.authority_epoch });

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 2, connectionTimeoutMillis: 1000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(resolve(import.meta.dir, '../../..'), 'access')) {
      await client.query(readFileSync(join(import.meta.dir, '../migrations/access', file), 'utf8'));
    }
    await registerFixtureIdentity(client, { principalId, ...principal, actor });
    await grantFixtureAuthority(client, {
      scope: 'work:create:root', requireDispatch: true,
      representations: [{ principalId, actor, action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor, action: 'agent.control', lifetime: 'infinity' },
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await new AccessPlatformAdministrators(pool).designateFirst(principal.issuer, principal.subject, () => undefined);
  grants = new AccessGrants(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

test('live exact authority overrides the wildcard; expiry and revocation restore foreign target refusal', async () => {
  const client = await pool.connect();
  const graph = { query: async () => ({ boolean: false }) };
  const allowed = () => platformAdministratorTargetAllowed(client, graph, principalId, actor, 'zone.edit', scope);
  try {
    // Bootstrap wildcard authority cannot edit someone else's Zone.
    expect(await allowed()).toBe(false);
    const wrong = await grants.platform.create(await context(), randomUUID(), action,
      { principalId }, null, receipt(), `zone:edit:https://rezics.com/id/${randomUUID()}`);
    expect(await allowed()).toBe(false);
    await grants.platform.revoke(await context(), wrong.grant.id, wrong.grant.generation, receipt());

    for (const invalidation of ['expire', 'revoke'] as const) {
      const exact = await grants.platform.create(await context(), randomUUID(), action,
        { principalId }, new Date(Date.now() + 3_600_000), receipt(), scope);
      expect(findPlatformPermission(await readPlatformPermissions(client, principalId), action, scope)?.id)
        .toBe(exact.grant.id);
      expect(await allowed()).toBe(true);
      const saved = await platformAdministratorProof(client, principalId, actor, true, { action: 'zone.edit', scope });
      expect(saved).not.toBeNull();
      expect(await platformAdministratorProofCurrent(client, saved!, principalId, actor)).toBe(true);
      if (invalidation === 'expire') {
        // Move the persisted deadline, exercising the SQL clock fence without a timed wait.
        await pool.query("UPDATE access.principal_permission_grant SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1",
          [exact.grant.id]);
      } else {
        await grants.platform.revoke(await context(), exact.grant.id, exact.grant.generation, receipt());
      }
      const live = await readPlatformPermissions(client, principalId);
      expect(live.some(row => row.id === exact.grant.id)).toBe(false);
      expect(findPlatformPermission(live, action, scope)?.scope_id).toBe('zone:edit:*');
      expect(await allowed()).toBe(false);
      expect(await platformAdministratorProofCurrent(client, saved!, principalId, actor)).toBe(false);
    }
  } finally {
    client.release();
  }
});
