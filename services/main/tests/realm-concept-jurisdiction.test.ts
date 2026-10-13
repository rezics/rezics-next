import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import { roleCommand, RealmAdminDenied, RealmAdminInvalid, type RoleChange } from '../src/modules/realm-admin/contract.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { AccessRealmManagement } from '../src/modules/access/realm-management.ts';
import { realmActionScope, realmConceptGrantProof, realmTransaction } from '../src/modules/access/realm-management-authority.ts';
import { ensureFixtureScopeGate, grantFixtureAuthority, registerFixtureIdentity } from '../src/modules/access/fixture-authority.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const command = (targetScope?: unknown) => ({
  actingSubject: id(), expectedGeneration: '0', reason: 'Manage placements in this Concept',
  change: { kind: 'role', roleId: randomUUID(), name: 'Concept placement managers',
    permissions: ['publication.adopt'], ...(targetScope === undefined ? {} : { targetScope }) },
});

test('Realm roles accept an exact Concept jurisdiction alongside existing Realm actions', () => {
  expect(Value.Check(roleCommand, command())).toBe(true);
  expect(Value.Check(roleCommand, command({ kind: 'concept', id: id() }))).toBe(true);
  expect(Value.Check(roleCommand, command(null))).toBe(true);
});

test('Realm role jurisdiction refuses wildcard, malformed and other target kinds', () => {
  for (const targetScope of [
    { kind: 'concept', id: '*' }, { kind: 'concept', id: 'news' },
    { kind: 'realm', id: id() }, { kind: 'concept', id: id(), broader: true },
  ]) expect(Value.Check(roleCommand, command(targetScope))).toBe(false);
});

let cluster: PostgresCluster;
let pool: Pool;
beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool(cluster.connection);
  const root = resolve(import.meta.dir, '../../..');
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
}, 120_000);
afterAll(async () => { await pool?.end(); cluster?.remove(); });

async function person(mandate = 'agent.control') {
  const actor = id(), principalId = randomUUID();
  const principal = { issuer: 'https://account.rezics.test', subject: randomUUID() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await registerFixtureIdentity(client, { principalId, actor, ...principal });
    await grantFixtureAuthority(client, { scope: `fixture:controller:${actor}`, requireDispatch: true,
      representations: [{ principalId, actor, action: mandate, lifetime: mandate === 'agent.control' ? 'infinity' : '8 hours' }],
      grant: { actor, action: 'fixture.control', lifetime: '8 hours' } });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  return { actor, principal, principalId };
}

async function fixture() {
  const owner = await person(), member = await person(), realm = id();
  for (const action of ['realm.roles.manage', 'realm.members.manage', 'publication.adopt']) {
    await grantFixtureAuthority(pool, { scope: realmActionScope(realm, action), requireDispatch: true,
      representations: [{ principalId: owner.principalId, actor: owner.actor, action: 'agent.control', lifetime: 'infinity' }],
      grant: { actor: owner.actor, action, lifetime: '8 hours' } });
  }
  const management = new AccessRealmManagement(pool);
  let generation = '0';
  const change = async (value: RoleChange) => {
    const input = { actingSubject: owner.actor, expectedGeneration: generation, reason: 'Bound Realm placement authority', change: value };
    const impact = await management.preview(owner.principal, realm, input);
    const receipt = await management.changeRole(owner.principal, realm, input, randomUUID(), impact.digest);
    generation = receipt.generation;
    return receipt;
  };
  const proof = (who: typeof member, concept: string, action = 'publication.adopt', targetRealm = realm) =>
    realmTransaction(pool, targetRealm, false, client => realmConceptGrantProof(client, who.principal,
      targetRealm, who.actor, concept, action));
  return { owner, member, realm, management, change, proof, generation: () => generation };
}

test('Concept role assignment, moves, omission and revocation retain exact jurisdiction', async () => {
  const f = await fixture(), first = id(), second = id(), roleId = randomUUID();
  const targetScope = { kind: 'concept' as const, id: first };
  await f.change({ kind: 'role', roleId, name: 'Placement managers', permissions: ['publication.adopt'], targetScope });
  expect((await f.management.roles(f.owner.principal, f.realm, f.owner.actor)).roles.find(r => r.id === roleId)?.targetScope).toEqual(targetScope);
  const validUntil = new Date(Date.now() + 3_600_000).toISOString();
  const assignment = { kind: 'assignment' as const, roleId, member: f.member.actor, assigned: true, validUntil, targetScope };
  const assigned = await f.change(assignment);
  expect(assigned.impact.changes).toMatchObject([{ member: f.member.actor,
    jurisdictions: [{ targetScope, gained: ['publication.adopt'], lost: [] }] }]);
  expect((await f.management.members(f.owner.principal, f.realm, { actingSubject: f.owner.actor })).items)
    .toMatchObject([{ member: f.member.actor, roles: [{ id: roleId, targetScope }] }]);
  expect(await f.proof(f.member, first)).not.toBeNull();
  expect(await f.proof(f.member, second)).toBeNull();
  expect(await f.proof(f.member, first, 'governance.moderate')).toBeNull();
  const otherRealm = id();
  await ensureFixtureScopeGate(pool, realmActionScope(otherRealm, 'realm.roles.manage'));
  expect(await f.proof(f.member, first, 'publication.adopt', otherRealm)).toBeNull();
  // A name/permission edit without a scope must never turn a narrow grant into a Realm-wide one.
  await f.change({ kind: 'role', roleId, name: 'Renamed placement managers', permissions: ['publication.adopt'] });
  expect(await f.proof(f.member, second)).toBeNull();
  const moved = await f.change({ kind: 'role', roleId, name: 'Renamed placement managers',
    permissions: ['publication.adopt'], targetScope: { kind: 'concept', id: second } });
  expect(moved.impact.affectedCount).toBe(1);
  expect(moved.impact.changes[0]?.jurisdictions).toEqual([
    { targetScope, gained: [], lost: ['publication.adopt'] },
    { targetScope: { kind: 'concept', id: second }, gained: ['publication.adopt'], lost: [] },
  ]);
  expect(await f.proof(f.member, first)).toBeNull();
  expect(await f.proof(f.member, second)).not.toBeNull();
  await expect(f.change(assignment)).rejects.toBeInstanceOf(RealmAdminInvalid);
  await f.change({ ...assignment, assigned: false, targetScope: { kind: 'concept', id: second } });
  expect(await f.proof(f.member, second)).toBeNull();
  expect((await f.management.roles(f.owner.principal, f.realm, f.owner.actor)).roles.find(r => r.id === roleId)?.targetScope)
    .toEqual({ kind: 'concept', id: second });
});

test('Concept decision proof refuses wildcard-only mandates, status-only operators and expired grants', async () => {
  const f = await fixture(), concept = id(), roleId = randomUUID(), wildcard = await person('*'), operator = await person();
  await grantFixtureAuthority(pool, { scope: 'platform:governance', requireDispatch: true,
    representations: [{ principalId: operator.principalId, actor: operator.actor, action: 'agent.control', lifetime: 'infinity' }],
    grant: { actor: operator.actor, action: 'platform.operator', lifetime: '8 hours' } });
  expect(await f.proof(operator, concept)).toBeNull();
  await f.change({ kind: 'role', roleId, name: 'Temporary placements', permissions: ['publication.adopt'],
    targetScope: { kind: 'concept', id: concept } });
  await f.change({ kind: 'assignment', roleId, member: wildcard.actor, assigned: true,
    validUntil: new Date(Date.now() + 3_600_000).toISOString() });
  expect(await f.proof(wildcard, concept)).toBeNull();
  const expires = new Date(Date.now() + 1000);
  await f.change({ kind: 'assignment', roleId, member: f.member.actor, assigned: true, validUntil: expires.toISOString() });
  expect(await f.proof(f.member, concept)).not.toBeNull();
  await Bun.sleep(Math.max(0, expires.getTime() - Date.now()) + 30);
  expect(await f.proof(f.member, concept)).toBeNull();
  // Ordinary existing Realm-wide authority is preserved, without requiring platform status.
  expect(await f.proof(f.owner, concept)).not.toBeNull();
});

test('Concept management grants cannot disclose the Realm-wide role or member directory', async () => {
  const f = await fixture(), concept = id(), roleId = randomUUID();
  await f.change({ kind: 'role', roleId, name: 'Narrow management',
    permissions: ['realm.roles.manage', 'realm.members.manage'], targetScope: { kind: 'concept', id: concept } });
  await f.change({ kind: 'assignment', roleId, member: f.member.actor, assigned: true,
    validUntil: new Date(Date.now() + 3_600_000).toISOString() });
  expect(await f.proof(f.member, concept, 'realm.roles.manage')).not.toBeNull();
  await expect(f.management.roles(f.member.principal, f.realm, f.member.actor)).rejects.toBeInstanceOf(RealmAdminDenied);
  await expect(f.management.members(f.member.principal, f.realm, { actingSubject: f.member.actor }))
    .rejects.toBeInstanceOf(RealmAdminDenied);
});
