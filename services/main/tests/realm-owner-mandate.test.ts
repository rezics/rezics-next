import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { AccessAdmissionRegistry, AdmissionDenied } from '../src/modules/access/admission.ts';
import { advanceFixtureAuthorityGeneration, fixtureAuthorityScenario, setFixtureGrantDeadline,
  setFixtureMandateState } from '../src/modules/access/fixture-authority-scenario.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { AccessRealmManagement } from '../src/modules/access/realm-management.ts';
import { requireRealmSubmissionPolicy } from '../src/modules/access/realm-management-settings.ts';
import { realmManager } from '../src/modules/access/realm-management-authority.ts';
import { RealmAdminDenied } from '../src/modules/realm-admin/contract.ts';
import { realmApprovedProof } from '../src/modules/realm-reply/member-policy.ts';
import { representedGrantProof } from '../src/modules/access/composition.ts';
import { visibleRealmReply } from '../src/modules/realm-reply/store.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

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
  if (mandateState) await setFixtureMandateState(pool, authority.representationIds[0]!, mandateState);
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
  expect(await h.management.settings(h.principal, h.realm, h.actor)).toMatchObject({ generation: '0' });
});

test('a member cannot read pre-admission history after the owner grant expires during Content review', async () => {
  const h = await fixture('agent.control');
  const membershipId = randomUUID();
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution')", [h.realm]);
  await pool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
    VALUES ('realm',$1,1,'terms:1')`, [h.realm]);
  await pool.query(`INSERT INTO access.membership (id,kind,owner_subject,member_subject,state,generation,
    policy_revision,terms_revision,consent_reference) VALUES ($1,'realm',$2,$3,'joined',1,1,'terms:1','fixture-consent')`,
  [membershipId,h.realm,h.actor]);
  await pool.query(`INSERT INTO access.realm_history_admission (kind,membership_id,generation,data_epoch,sequence)
    VALUES ('agent',$1,1,'epoch',10)`, [membershipId]);
  const reply = `https://rezics.com/id/${randomUUID()}`;
  const uri = (value: string) => ({ type: 'uri', value });
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: '0' }, fuseki: { query: async (sql: string) => {
    if (sql.includes('SELECT ?space ?realmRevision')) return { results: { bindings: [{
      space: uri(`https://rezics.com/id/${membershipId}`), disclosure: uri(`${RV}Private`),
      history: { type: 'literal', value: 'from-admission' } }] } };
    // The reply predates sequence 10, so a history-cut ASK must refuse it.
    if (sql.includes('ASK')) return { boolean: false };
    return { results: { bindings: [{ reply: uri(reply), placement: uri(`https://rezics.com/id/${randomUUID()}`),
      revision: uri(`urn:rezics:content:revision:${randomUUID()}`), review: uri(`urn:rezics:realm-review:${randomUUID()}`),
      root: uri(reply), rootRevision: uri(reply), author: uri(h.actor), preparation: uri('fixture-reply') }] } };
  } } } as unknown as WorkActivationEnvironment;
  const before = await h.access.realmReadProof(h.principal,h.actor,h.realm);
  expect(before).toBeString();
  expect(await h.access.realmHistoryFloor(h.principal,h.actor,h.realm)).toBeNull();
  const deadline = await setFixtureGrantDeadline(pool,h.grantId,1000);
  let reviews = 0;
  const content = { currentReview: async () => {
    reviews++;
    await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz - clock_timestamp())) + 0.02)', [deadline]);
    return true;
  } };
  expect(await visibleRealmReply(content,h.access,env,h.realm,reply,h.principal,h.actor)).toBeNull();
  expect(reviews).toBe(1);
  expect(await h.access.realmHistoryFloor(h.principal,h.actor,h.realm)).toEqual({ dataEpoch: 'epoch', sequence: '10' });
  expect(await h.access.realmReadProof(h.principal,h.actor,h.realm)).not.toBe(before);
  expect(await visibleRealmReply(content,h.access,env,h.realm,reply,h.principal,h.actor)).toBeNull();
  expect(reviews).toBe(1);
});

for (const table of ['principal','representation','authority_subject','permission_grant','scope_gate'] as const) {
  test(`represented grant proofs retain the selected ${table} generation`, async () => {
    const h = await fixture('realm.owner');
    const before = await representedGrantProof(pool,h.principal,h.actor,h.scope,'realm.owner');
    expect(before).not.toBeNull();
    const id = table === 'principal' ? h.principalId : table === 'representation' ? h.representationIds[0]!
      : table === 'authority_subject' ? h.actor : table === 'permission_grant' ? h.grantId : h.scope;
    await advanceFixtureAuthorityGeneration(pool,table,id);
    const after = await representedGrantProof(pool,h.principal,h.actor,h.scope,'realm.owner');
    expect(after).not.toBeNull();
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });
}

test('baseline Realm owner participation retains the selected owner mandate generation', async () => {
  const h = await fixture('realm.owner');
  const client = await pool.connect();
  try {
    const before = await realmApprovedProof(client,h.realm,h.principalId,h.actor);
    expect(before).toStartWith('owner:');
    await advanceFixtureAuthorityGeneration(pool,'representation',h.representationIds[0]!);
    expect(await realmApprovedProof(client,h.realm,h.principalId,h.actor)).not.toBe(before);
  } finally { client.release(); }
});
