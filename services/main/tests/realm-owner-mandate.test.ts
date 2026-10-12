import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { AccessAdmissionRegistry, AdmissionDenied } from '../src/modules/access/admission.ts';
import { fixtureAuthorityScenario } from '../src/modules/access/fixture-authority-scenario.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { AccessRealmManagement } from '../src/modules/access/realm-management.ts';
import { requireRealmSubmissionPolicy } from '../src/modules/access/realm-management-settings.ts';
import { realmManager } from '../src/modules/access/realm-management-authority.ts';
import { RealmAdminDenied } from '../src/modules/realm-admin/contract.ts';
import { realmApprovedProof } from '../src/modules/realm-reply/member-policy.ts';

let cluster: PostgresCluster, pool: Pool;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4 });
  const root = resolve(import.meta.dir, '../../..');
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
}, 120_000);
afterAll(async () => { await pool?.end(); cluster?.remove(); });

async function fixture(mandate: string, mandateState?: 'expired' | 'revoked') {
  const realm = `https://rezics.com/id/${randomUUID()}`;
  const scope = `governance:realm:${realm}`;
  const authority = await fixtureAuthorityScenario(pool, { scope, action: 'realm.owner', mandate });
  await pool.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1)', [realm]);
  await pool.query(`INSERT INTO access.realm_admin_settings (realm,visibility,history,who_may_submit)
    VALUES ($1,'private','from-admission','members')`, [realm]);
  const principalId = (await pool.query<{ id: string }>('SELECT id FROM access.principal WHERE account_subject = $1',
    [authority.principal.subject])).rows[0]!.id;
  await grantFixtureAuthority(pool, { scope, requireDispatch: true,
    representations: [{ principalId, actor: authority.actor, action: mandate,
      lifetime: mandate === 'agent.control' ? 'infinity' : '8 hours' }],
    grant: { actor: authority.actor, action: 'realm.settings.manage', lifetime: '8 hours' } });
  if (mandateState === 'expired') {
    await pool.query("UPDATE access.representation SET valid_until = clock_timestamp() - interval '1 second' WHERE id = $1",
      [authority.representationIds[0]]);
  } else if (mandateState === 'revoked') {
    await pool.query('UPDATE access.representation SET active = false WHERE id = $1', [authority.representationIds[0]]);
  }
  return { ...authority, realm, scope, principalId, access: new AccessAdmissionRegistry(pool),
    management: new AccessRealmManagement(pool) };
}

for (const scenario of [
  { mandate: 'work.create' },
  { mandate: 'realm.owner', mandateState: 'expired' },
  { mandate: 'realm.owner', mandateState: 'revoked' },
] as const) {
  test(`private Realm ownership denies ${scenario.mandate}/${'mandateState' in scenario ? scenario.mandateState : 'live'}`, async () => {
    const h = await fixture(scenario.mandate, 'mandateState' in scenario ? scenario.mandateState : undefined);
    expect(await h.access.realmReadProof(h.principal, h.actor, h.realm)).toBeNull();
    await expect(h.access.withRealmPolicy(h.principal, h.actor, h.realm, 'read', async () => true))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const client = await pool.connect();
    try {
      expect(await realmApprovedProof(client, h.realm, h.principalId, h.actor)).toBeNull();
      await expect(requireRealmSubmissionPolicy(client, h.realm, h.principalId, h.actor))
        .rejects.toBeInstanceOf(AdmissionDenied);
      await expect(realmManager(client, h.principal, h.realm, h.actor, 'realm.settings.manage'))
        .rejects.toBeInstanceOf(RealmAdminDenied);
    } finally { client.release(); }
    await expect(h.management.settings(h.principal, h.realm, h.actor)).rejects.toBeInstanceOf(RealmAdminDenied);
  });
}

for (const mandate of ['realm.owner', 'agent.control']) {
  test(`private Realm owner participation accepts a live ${mandate} mandate`, async () => {
    const h = await fixture(mandate);
    expect(await h.access.realmReadProof(h.principal, h.actor, h.realm)).toBeString();
    expect(await h.access.realmHistoryFloor(h.principal, h.actor, h.realm)).toBeNull();
    const client = await pool.connect();
    try {
      expect(await realmApprovedProof(client, h.realm, h.principalId, h.actor)).toStartWith('owner:');
      expect(await requireRealmSubmissionPolicy(client, h.realm, h.principalId, h.actor))
        .toEqual([{ table: 'permission_grant', id: h.grantId, generation: '0' }]);
    } finally { client.release(); }
  });
}

test('Realm ownership mandate cannot consume another management grant; an exact management mandate can', async () => {
  const h = await fixture('realm.owner');
  await expect(h.management.settings(h.principal, h.realm, h.actor)).rejects.toBeInstanceOf(RealmAdminDenied);
  await grantFixtureAuthority(pool, { scope: h.scope, requireDispatch: true,
    representations: [{ principalId: h.principalId, actor: h.actor, action: 'realm.settings.manage', lifetime: '8 hours' }],
    grant: { actor: h.actor, action: 'realm.settings.manage', lifetime: '8 hours' } });
  expect(await h.management.settings(h.principal, h.realm, h.actor)).toMatchObject({ generation: '1' });
});
