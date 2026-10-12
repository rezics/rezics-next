import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { normalizeAddressAlias } from '@rezics/model/address/aliases';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import {
  erasePersonProvisionProfile, listEndedPersonProvisions, personProvisionProfileErased, withPersonProfileErasureAuthority,
  PersonProfileErasureDenied, PersonProfileErasureStale, PersonProfileErasureUnavailable,
  type PersonProfileErasureProof,
} from '../src/modules/access/person-profile-erasure.ts';
import { erasePersonProfileAliases, listPersonProfileAliases, personProfileAliasesErased } from '../src/modules/address/person-profile-erasure.ts';
import { erasePersonProfileGraph, PersonGraphErasureConflict, type PersonProfileGraphInventory } from '../src/modules/agent/erasure.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { PublicReports, type ReportTarget } from '../src/modules/public-report/store.ts';
import { GovernanceConflict, GovernanceDenied, GovernanceUnavailable } from '../src/modules/governance/store.ts';
import { AliasRegistry, AliasConflict } from '../src/modules/address/registry.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let cluster: PostgresCluster | undefined;
let access: Pool;
let relay: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  access = new Pool({ ...cluster.connection, max: 6 });
  relay = new Pool({ ...cluster.connection, max: 2 });
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    // Session B owns the production journal link. This isolated owner fixture
    // models its sealed identity, without replacing or loosening that migration.
    await client.query(`CREATE SCHEMA relay;
      CREATE TABLE relay.erasure (
        id uuid PRIMARY KEY, erasure_epoch bigint NOT NULL, account_erasure_id uuid,
        kind text NOT NULL, authority text NOT NULL, operation_id text,
        suppression_status text NOT NULL, stage text NOT NULL,
        deleted_principal_id uuid, account_issuer text, account_subject text
      );
      CREATE TABLE relay.account_deletion_intent (
        principal_id uuid PRIMARY KEY, outbox_id uuid NOT NULL, authority_epoch bigint NOT NULL
      );
      CREATE TABLE relay.erasure_target (
        erasure_id uuid NOT NULL, owner text NOT NULL, target_kind text NOT NULL, target_ref text NOT NULL
      );`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}, 60_000);

afterAll(async () => {
  await relay?.end();
  await access?.end();
  cluster?.remove();
});

async function principal() {
  const id = randomUUID();
  const issuer = 'https://account.rezics.test';
  const subject = randomUUID();
  await access.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [id, issuer, subject]);
  return { id, issuer, subject };
}

type Principal = Awaited<ReturnType<typeof principal>>;
async function provision(owner: Principal, kind: 'person' | 'organization' = 'person') {
  const person = native();
  const id = randomUUID();
  const displayName = `Private ${kind} name ${id}`;
  await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [person]);
  const authority = await grantFixtureAuthority(access, {
    scope: 'work:create:root', requireDispatch: true,
    representations: [{ principalId: owner.id, actor: person, action: 'agent.control', lifetime: 'infinity' }],
    grant: { actor: person, action: 'agent.control', lifetime: 'infinity' },
  });
  await access.query(`INSERT INTO access.agent_provision
    (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind, display_name,
     principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,$5,$6,0,'active','person-erasure-fixture',7,$7)`,
  [id, owner.id, digest(id), person, kind, displayName, authority.representationIds[0]]);
  return { id, person, displayName };
}

async function endedFixture(options: { principalActive?: boolean; subjectActive?: boolean;
  kind?: 'person' | 'organization'; sibling?: boolean } = {}) {
  const owner = await principal();
  const profile = await provision(owner, options.kind);
  const sibling = options.sibling ? await provision(owner) : undefined;
  const deletionIntentId = randomUUID();
  await access.query('UPDATE access.principal SET active = $2, enforcement_epoch = 1 WHERE id = $1',
    [owner.id, options.principalActive ?? false]);
  await access.query('UPDATE access.authority_subject SET active = $2, generation = 1 WHERE id = ANY($1::text[])',
    [[profile.person, ...(sibling ? [sibling.person] : [])], options.subjectActive ?? false]);
  await access.query(`INSERT INTO access.outbox (id, kind, principal_id, authority_epoch)
    VALUES ($1,'account.deletion_fenced',$2,1)`, [deletionIntentId, owner.id]);
  const proof: PersonProfileErasureProof = {
    erasureId: randomUUID(), erasureEpoch: '1', accountErasureId: randomUUID(),
    principalId: owner.id, person: profile.person, provisionId: profile.id,
    deletionIntentId, deletionEnforcementEpoch: '1', subjectEpoch: '1',
  };
  await sealFixtureJournal(owner, proof);
  return { owner, profile, proof, sibling };
}

async function sealFixtureJournal(owner: Principal, proof: PersonProfileErasureProof) {
  await relay.query(`INSERT INTO relay.erasure
    (id, erasure_epoch, kind, authority, suppression_status, stage, deleted_principal_id, account_issuer, account_subject)
    VALUES ($1,1,'account','account_deletion','suppressed','inventory_complete',$2,$3,$4)`,
  [proof.accountErasureId, owner.id, owner.issuer, owner.subject]);
  await relay.query(`INSERT INTO relay.erasure
    (id, erasure_epoch, account_erasure_id, kind, authority, operation_id, suppression_status, stage)
    VALUES ($1,$2,$3,'resource','account_deletion',$4,'suppressed','inventory_complete')`,
  [proof.erasureId, proof.erasureEpoch, proof.accountErasureId, `account-profile-erasure:${proof.accountErasureId}`]);
  await relay.query('INSERT INTO relay.account_deletion_intent (principal_id,outbox_id,authority_epoch) VALUES ($1,$2,$3)',
    [owner.id, proof.deletionIntentId, proof.deletionEnforcementEpoch]);
  await relay.query(`INSERT INTO relay.erasure_target (erasure_id,owner,target_kind,target_ref)
    VALUES ($1,'access','principal',$2),($1,'graph','person_head',$3)`,
  [proof.erasureId, owner.id, proof.person]);
}

async function provisionRow(id: string) {
  return (await access.query<Record<string, unknown>>('SELECT * FROM access.agent_provision WHERE id = $1', [id])).rows[0]!;
}

test('sole-controller Account deletion ends the retained Person authority before profile inventory', async () => {
  const owner = await principal();
  const profile = await provision(owner);
  const fence = await new AccessAdmissionRegistry(access).strongDeactivateAccountSubject(owner.issuer, owner.subject);
  expect(fence).toMatchObject({ principalId: owner.id, enforcementEpoch: '1' });
  // This is the real integration dependency on Account Person-authority ending.
  // Other owner cases use explicit ended fixture state, so this gap is isolated.
  expect((await access.query<{ active: boolean }>('SELECT active FROM access.authority_subject WHERE id = $1',
    [profile.person])).rows[0]?.active).toBe(false);
  expect(await listEndedPersonProvisions(access, owner.id, 1)).toEqual([
    expect.objectContaining({ provisionId: profile.id, person: profile.person, principalId: owner.id }),
  ]);
});

test('Account deletion preserves a Person controlled by another live principal', async () => {
  const owner = await principal();
  const profile = await provision(owner);
  const otherController = await principal();
  await grantFixtureAuthority(access, {
    scope: 'work:create:root', requireDispatch: true,
    representations: [{ principalId: otherController.id, actor: profile.person, action: 'agent.control', lifetime: 'infinity' }],
    grant: { actor: profile.person, action: 'agent.control', lifetime: 'infinity' },
  });
  const before = await provisionRow(profile.id);
  const fence = await new AccessAdmissionRegistry(access).strongDeactivateAccountSubject(owner.issuer, owner.subject);
  expect(fence).toMatchObject({ principalId: owner.id, enforcementEpoch: '1' });
  expect((await access.query<{ active: boolean }>('SELECT active FROM access.authority_subject WHERE id = $1',
    [profile.person])).rows[0]?.active).toBe(true);
  expect(await listEndedPersonProvisions(access, owner.id, 1)).toEqual([]);
  expect(await provisionRow(profile.id)).toEqual(before);
});

test('exact retained Person name disappears while opaque identity and unrelated rows remain', async () => {
  const fixture = await endedFixture();
  const unrelated = await endedFixture();
  const organization = await provision(await principal(), 'organization');
  const before = await provisionRow(fixture.profile.id);
  const unrelatedBefore = await provisionRow(unrelated.profile.id);
  const organizationBefore = await provisionRow(organization.id);
  expect(await personProvisionProfileErased(access, fixture.proof)).toBe(false);
  await erasePersonProvisionProfile(access, relay, fixture.proof);
  expect(await personProvisionProfileErased(access, fixture.proof)).toBe(true);
  const after = await provisionRow(fixture.profile.id);
  expect(after).toMatchObject({ display_name: null, profile_erasure_id: fixture.proof.erasureId,
    account_erasure_id: fixture.proof.accountErasureId, state: 'active' });
  for (const field of ['id', 'principal_id', 'agent_id', 'request_digest', 'representation_id',
    'graph_data_epoch', 'graph_sequence', 'created_at']) expect(after[field]).toEqual(before[field]);
  expect(JSON.stringify(after)).not.toContain(fixture.profile.displayName);
  expect(await provisionRow(unrelated.profile.id)).toEqual(unrelatedBefore);
  expect(await provisionRow(organization.id)).toEqual(organizationBefore);
  const first = await provisionRow(fixture.profile.id);
  await erasePersonProvisionProfile(access, relay, fixture.proof);
  expect(await provisionRow(fixture.profile.id)).toEqual(first);
});

test('ordinary terminal provision writes cannot sanitize or restore a name', async () => {
  const { proof, profile } = await endedFixture();
  await expect(access.query('UPDATE access.agent_provision SET display_name = NULL WHERE id = $1', [profile.id]))
    .rejects.toMatchObject({ code: '23514' });
  await erasePersonProvisionProfile(access, relay, proof);
  await expect(access.query('UPDATE access.agent_provision SET display_name = $2 WHERE id = $1', [profile.id, profile.displayName]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(access.query('DELETE FROM access.agent_provision WHERE id = $1', [profile.id]))
    .rejects.toMatchObject({ code: '23514' });
});

test('active principal, active Person and Organization sanitation are denied without mutation', async () => {
  for (const options of [{ principalActive: true }, { subjectActive: true }, { kind: 'organization' as const }]) {
    const { proof, profile } = await endedFixture(options);
    const before = await provisionRow(profile.id);
    await expect(erasePersonProvisionProfile(access, relay, proof)).rejects.toBeInstanceOf(PersonProfileErasureDenied);
    expect(await provisionRow(profile.id)).toEqual(before);
  }
});

test('another Account parent, Person target or unsealed child cannot authorize sanitation', async () => {
  const { proof, profile } = await endedFixture();
  const other = await endedFixture();
  const before = await provisionRow(profile.id);
  for (const changed of [{ accountErasureId: other.proof.accountErasureId }, { person: other.profile.person },
    { provisionId: other.profile.id }, { erasureEpoch: '2' }]) {
    await expect(erasePersonProvisionProfile(access, relay, { ...proof, ...changed }))
      .rejects.toBeInstanceOf(PersonProfileErasureDenied);
  }
  await relay.query("UPDATE relay.erasure SET stage = 'requested' WHERE id = $1", [proof.erasureId]);
  await expect(erasePersonProvisionProfile(access, relay, proof)).rejects.toBeInstanceOf(PersonProfileErasureDenied);
  expect(await provisionRow(profile.id)).toEqual(before);
});

test('changed enforcement and Person generations refuse stale sealed owner proofs', async () => {
  for (const owner of ['principal', 'subject'] as const) {
    const { proof, profile } = await endedFixture();
    if (owner === 'principal') await access.query('UPDATE access.principal SET enforcement_epoch = 2 WHERE id = $1', [proof.principalId]);
    else await access.query('UPDATE access.authority_subject SET generation = 2 WHERE id = $1', [proof.person]);
    await expect(erasePersonProvisionProfile(access, relay, proof)).rejects.toBeInstanceOf(PersonProfileErasureStale);
    expect((await provisionRow(profile.id)).display_name).toBe(profile.displayName);
  }
});

test('closed recovery fence refuses sanitation; recovery resumes the same sealed proof', async () => {
  const { proof, profile } = await endedFixture();
  const generation = await engageAccessRecoveryFence(access);
  try {
    await expect(erasePersonProvisionProfile(access, relay, proof)).rejects.toBeInstanceOf(PersonProfileErasureUnavailable);
    expect((await provisionRow(profile.id)).display_name).toBe(profile.displayName);
  } finally { await releaseAccessRecoveryFence(access, generation); }
  await erasePersonProvisionProfile(access, relay, proof);
  expect(await personProvisionProfileErased(access, proof)).toBe(true);
});

test('unavailable Account-child journal schema fails closed without touching the provision', async () => {
  const { proof, profile } = await endedFixture();
  const journal = await relay.connect();
  try {
    await journal.query('BEGIN');
    await journal.query('ALTER TABLE relay.erasure DROP COLUMN account_erasure_id');
    await expect(erasePersonProvisionProfile(access, journal, proof)).rejects.toBeInstanceOf(PersonProfileErasureUnavailable);
    expect((await provisionRow(profile.id)).display_name).toBe(profile.displayName);
  } finally {
    await journal.query('ROLLBACK');
    journal.release();
  }
});

test('concurrent sanitation of the same proof converges and another proof remains stale', async () => {
  const { proof, owner } = await endedFixture();
  await Promise.all([erasePersonProvisionProfile(access, relay, proof), erasePersonProvisionProfile(access, relay, proof)]);
  expect(await personProvisionProfileErased(access, proof)).toBe(true);
  const next = { ...proof, erasureId: randomUUID() };
  await relay.query(`INSERT INTO relay.erasure (id,erasure_epoch,account_erasure_id,kind,authority,operation_id,suppression_status,stage)
    VALUES ($1,1,$2,'resource','account_deletion',$3,'suppressed','inventory_complete')`,
  [next.erasureId, next.accountErasureId, `account-profile-erasure:${next.accountErasureId}`]);
  await relay.query(`INSERT INTO relay.erasure_target (erasure_id,owner,target_kind,target_ref)
    VALUES ($1,'access','principal',$2),($1,'graph','person_head',$3)`, [next.erasureId, owner.id, next.person]);
  await expect(erasePersonProvisionProfile(access, relay, next)).rejects.toBeInstanceOf(PersonProfileErasureStale);
  expect(await personProvisionProfileErased(access, next)).toBe(false);
});

test('locked owner provision refuses a concurrent attempt and recovers after rollback', async () => {
  const { proof, profile } = await endedFixture();
  const blocker: PoolClient = await access.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM access.agent_provision WHERE id = $1 FOR UPDATE', [profile.id]);
    await expect(erasePersonProvisionProfile(access, relay, proof)).rejects.toBeInstanceOf(PersonProfileErasureStale);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  expect((await provisionRow(profile.id)).display_name).toBe(profile.displayName);
  await erasePersonProvisionProfile(access, relay, proof);
  expect(await personProvisionProfileErased(access, proof)).toBe(true);
}, 10_000);

test('retained Person lookup is bounded and cannot silently truncate the closure', async () => {
  const { proof, profile } = await endedFixture();
  expect(await listEndedPersonProvisions(access, proof.principalId, 1)).toEqual([
    expect.objectContaining({ provisionId: profile.id, person: profile.person, subjectEpoch: '1' }),
  ]);
  await expect(listEndedPersonProvisions(access, proof.principalId, 0)).rejects.toBeInstanceOf(PersonProfileErasureDenied);
  await expect(listEndedPersonProvisions(access, proof.principalId, 257)).rejects.toBeInstanceOf(PersonProfileErasureDenied);
});

async function aliasCopies(owner: Principal, person: string, receiptOwner = owner) {
  const key = `privateperson${randomUUID().slice(0, 8)}`;
  const previousKey = `formerperson${randomUUID().slice(0, 8)}`;
  const idempotencyKey = `alias:${randomUUID()}`;
  for (const [alias, state] of [[key, 'current'], [previousKey, 'redirect']] as const) {
    const revision = randomUUID();
    const skeleton = normalizeAddressAlias(alias, 'ascii-handle').skeleton;
    await access.query(`INSERT INTO access.alias_registry
      (scope,key,skeleton,holder,controller,state,revision)
      VALUES ('agent',$1,$5,$2,$2,$3,$4)`, [alias, person, state, revision, skeleton]);
    await access.query(`INSERT INTO access.alias_history (revision,scope,key,holder,state)
      VALUES ($1,'agent',$2,$3,$4)`, [revision, alias, person, state]);
  }
  await access.query(`INSERT INTO access.alias_receipt (principal_id,idempotency_key,request_digest,result)
    VALUES ($1,$2,$3,$4)`, [receiptOwner.id, idempotencyKey, digest(idempotencyKey), JSON.stringify({
    profile: 'alias-write-v1', scope: 'agent', holder: person, key, previousKey,
    state: 'current', revision: randomUUID(), changedAt: new Date().toISOString(), replayed: false,
  })]);
  await access.query(`INSERT INTO access.alias_graph_import_report (data_epoch,source,reason,legacy_alias)
    VALUES ('person-erasure-fixture',$1,$2,$3)`, [
    `${person}#${key}`, `Skipped legacy alias ${key}`, JSON.stringify({ holder: { value: person }, key: { value: key } }),
  ]);
  return { key, previousKey, idempotencyKey, receiptPrincipal: receiptOwner.id };
}

async function aliasRows(person: string) {
  return {
    registry: (await access.query('SELECT * FROM access.alias_registry WHERE holder = $1 ORDER BY key_digest', [person])).rows,
    history: (await access.query('SELECT * FROM access.alias_history WHERE holder = $1 ORDER BY revision', [person])).rows,
    receipts: (await access.query("SELECT * FROM access.alias_receipt WHERE result->>'holder' = $1 ORDER BY idempotency_key", [person])).rows,
    imports: (await access.query('SELECT * FROM access.alias_graph_import_report WHERE holder = $1 ORDER BY source_digest', [person])).rows,
  };
}

test('Person alias copies erase by exact holder across delegated receipts; permanent digests survive', async () => {
  const { owner, profile, proof } = await endedFixture();
  const copies = await aliasCopies(owner, profile.person, await principal());
  const unrelated = await endedFixture();
  await aliasCopies(unrelated.owner, unrelated.profile.person);
  const organization = await provision(await principal(), 'organization');
  // The same deleted principal can retain a receipt for an unrelated holder.
  await aliasCopies(owner, organization.person);
  const before = await aliasRows(profile.person);
  const unrelatedBefore = await aliasRows(unrelated.profile.person);
  const organizationBefore = await aliasRows(organization.person);
  const inventory = await sealedAliases(proof, 6);
  expect(inventory.entries).toHaveLength(6);
  expect(new Set(inventory.entries.map(entry => entry.owner))).toEqual(new Set(['registry', 'history', 'receipt', 'import']));
  expect(JSON.stringify(inventory)).not.toContain(copies.key);
  expect(JSON.stringify(inventory)).not.toContain(copies.previousKey);
  expect(await personProfileAliasesErased(access, proof)).toBe(false);
  await erasePersonProfileAliases(access, relay, proof, inventory);
  await erasePersonProvisionProfile(access, relay, proof);
  expect(await personProfileAliasesErased(access, proof)).toBe(true);
  const after = await aliasRows(profile.person);
  expect(JSON.stringify(after)).not.toContain(copies.key);
  expect(JSON.stringify(after)).not.toContain(copies.previousKey);
  expect(after.registry.map(row => row.key_digest)).toEqual(before.registry.map(row => row.key_digest));
  expect(after.registry.map(row => row.skeleton_digest)).toEqual(before.registry.map(row => row.skeleton_digest));
  expect(after.history.map(row => row.key_digest)).toEqual(before.history.map(row => row.key_digest));
  expect(after.imports.map(row => row.source_digest)).toEqual(before.imports.map(row => row.source_digest));
  expect(after.receipts[0]?.principal_id).toBe(copies.receiptPrincipal);
  expect(await aliasRows(unrelated.profile.person)).toEqual(unrelatedBefore);
  expect(await aliasRows(organization.person)).toEqual(organizationBefore);
  const registry = new AliasRegistry(access);
  expect(await registry.lookup('agent', copies.key)).toBeNull();
  expect((await registry.currents([profile.person])).size).toBe(0);
  expect((await registry.heads(['agent'], [profile.person])).size).toBe(0);
  expect(await registry.availability('agent', copies.key)).toEqual({ available: false, reason: 'retained' });
  expect(await registry.availability('space', copies.key)).toEqual({ available: false, reason: 'confusable' });
  expect(await registry.firstAvailable('agent', [copies.key, copies.previousKey])).toBeNull();
  expect(await registry.firstAvailable('space', [copies.key])).toBeNull();
  await erasePersonProfileAliases(access, relay, proof, inventory);
  expect(await aliasRows(profile.person)).toEqual(after);
});

test('changed alias receipt inventory and recollection refuse under the original seal', async () => {
  const { owner, profile, proof } = await endedFixture();
  const copies = await aliasCopies(owner, profile.person);
  const inventory = await sealedAliases(proof, 6);
  await access.query(`UPDATE access.alias_receipt SET result = result || '{"changedAt":"changed"}'::jsonb
    WHERE principal_id = $1 AND idempotency_key = $2`, [copies.receiptPrincipal, copies.idempotencyKey]);
  const changed = await aliasRows(profile.person);
  await expect(erasePersonProfileAliases(access, relay, proof, inventory)).rejects.toBeInstanceOf(PersonProfileErasureStale);
  expect(await aliasRows(profile.person)).toEqual(changed);
  const recovered = await listPersonProfileAliases(access, relay, proof, 6);
  await expect(erasePersonProfileAliases(access, relay, proof, recovered)).rejects.toBeInstanceOf(PersonProfileErasureStale);
  expect(await aliasRows(profile.person)).toEqual(changed);
});

test('alias sanitation rejects forged fingerprints, bypass stamps and replanted names', async () => {
  const { owner, profile, proof } = await endedFixture();
  const copies = await aliasCopies(owner, profile.person);
  const inventory = await sealedAliases(proof, 6);
  const entries = inventory.entries.map(entry => ({ ...entry, fingerprint: digest('forged') }));
  await expect(erasePersonProfileAliases(access, relay, proof, { entries, digest: digest(JSON.stringify(entries)) }))
    .rejects.toBeInstanceOf(PersonProfileErasureStale);
  await expect(access.query(`UPDATE access.alias_registry SET key = NULL,skeleton = NULL,state = 'retired',
    profile_erasure_id = $2,profile_erasure_epoch = 1 WHERE holder = $1`, [profile.person, proof.erasureId]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(access.query('DELETE FROM access.alias_history WHERE holder = $1', [profile.person]))
    .rejects.toMatchObject({ code: '23514' });
  await erasePersonProfileAliases(access, relay, proof, inventory);
  // Alias-owner terminal evidence closes replanting before the next owner has
  // sanitized the provision display-name copy.
  expect((await provisionRow(profile.id)).display_name).toBe(profile.displayName);
  await expect(access.query(`INSERT INTO access.alias_registry (scope,key,skeleton,holder,controller,state)
    VALUES ('agent','replantedperson','replantedperson',$1,$1,'current')`, [profile.person]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(access.query(`INSERT INTO access.alias_receipt (principal_id,idempotency_key,request_digest,result)
    VALUES ($1,'replanted-alias',$2,$3)`, [owner.id, digest('replanted-alias'), JSON.stringify({
    profile: 'alias-write-v1', scope: 'agent', holder: profile.person, key: 'replantedperson',
  })])).rejects.toMatchObject({ code: '23514' });
  await expect(access.query(`INSERT INTO access.alias_graph_import_report (data_epoch,source,reason,legacy_alias)
    VALUES ('person-erasure-fixture',$1,'replanted alias',$2)`, [
    `${profile.person}#replantedperson`, JSON.stringify({ holder: { value: profile.person }, key: { value: 'replantedperson' } }),
  ])).rejects.toMatchObject({ code: '23514' });
  await erasePersonProvisionProfile(access, relay, proof);
  await expect(access.query(`UPDATE access.alias_registry SET key = $2,skeleton = $2
    WHERE holder = $1 AND key_digest = access.alias_digest($2)`, [profile.person, copies.key]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(access.query(`INSERT INTO access.alias_registry (scope,key,skeleton,holder,controller,state)
    VALUES ('agent','replantedperson','replantedperson',$1,$1,'current')`, [profile.person]))
    .rejects.toMatchObject({ code: '23514' });
});

test('alias inventory budget refuses overflow without changing any owner copy', async () => {
  const { owner, profile, proof } = await endedFixture();
  await aliasCopies(owner, profile.person);
  const before = await aliasRows(profile.person);
  await expect(listPersonProfileAliases(access, relay, proof, 5)).rejects.toBeInstanceOf(PersonProfileErasureDenied);
  expect(await aliasRows(profile.person)).toEqual(before);
});

function graphInventory(proof: PersonProfileErasureProof): PersonProfileGraphInventory {
  const head = native();
  return { person: proof.person, provisionId: proof.provisionId, head, profileHead: null,
    revisions: [{ revision: head, manifest: null }, { revision: native(), manifest: null }],
    objects: [], units: [], authorUnits: [], creditedWorks: [] };
}
async function sealGraphInventory(proof: PersonProfileErasureProof, inventory: PersonProfileGraphInventory) {
  const targets = [
    ['graph', 'person_profile_inventory', `${proof.person}|${digest(JSON.stringify(inventory))}`],
    ...inventory.revisions.map(value => ['graph', 'person_profile_revision', value.revision]),
  ];
  for (const [owner, kind, ref] of targets) await relay.query(`INSERT INTO relay.erasure_target
    (erasure_id,owner,target_kind,target_ref) VALUES ($1,$2,$3,$4)`, [proof.erasureId, owner, kind, ref]);
}
test('Agent owner refuses an omitted historical revision before dispatching the graph command', async () => {
  const { proof } = await endedFixture();
  const complete = graphInventory(proof);
  await sealGraphInventory(proof, complete);
  let commands = 0;
  class Graph extends FusekiClient {
    constructor() { super('http://person-erasure.invalid'); }
    override async query() { return { boolean: true }; }
    override async commandWithReceipt(): Promise<never> { commands++; throw new Error('must never dispatch'); }
  }
  await expect(erasePersonProfileGraph(access, relay, new Graph(),
    { dataEpoch: 'fixture', routingEpoch: '1' }, proof,
    { ...complete, revisions: [complete.revisions[0]!] })).rejects.toBeInstanceOf(PersonGraphErasureConflict);
  expect(commands).toBe(0);
});

async function sealedAliases(proof: PersonProfileErasureProof, limit: number) {
  const inventory = await listPersonProfileAliases(access, relay, proof, limit);
  await relay.query(`INSERT INTO relay.erasure_target (erasure_id,owner,target_kind,target_ref)
    VALUES ($1,'access','person_alias_inventory',$2)`, [proof.erasureId, `${proof.person}|${inventory.digest}`]);
  return inventory;
}

test('unlanded Person migrations keep the retired Agent handle bridge absent', async () => {
  expect((await access.query("SELECT to_regclass('access.agent_handle') AS bridge")).rows[0]?.bridge).toBeNull();
});

test('the actual Person sanitation guard lookup uses the principal primary-key index', async () => {
  const { proof } = await endedFixture();
  const definition = (await access.query<{ body: string }>(`SELECT pg_get_functiondef(
    'access.assert_person_profile_erasure(text)'::regprocedure) AS body`)).rows[0]!.body;
  const condition = /JOIN access.principal p ON ([^\n]+)/.exec(definition)![1]!.replaceAll('context', '$1::jsonb');
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const plan = (await client.query(`EXPLAIN (FORMAT JSON) SELECT p.id FROM access.principal p WHERE ${condition}`,
      [JSON.stringify(proof)])).rows[0]!['QUERY PLAN'];
    expect(JSON.stringify(plan)).toContain('Index Cond');
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('a live admitted Space claim cannot take an erased opaque Agent reservation', async () => {
  const erased = await endedFixture();
  const copies = await aliasCopies(erased.owner, erased.profile.person);
  const sealed = await sealedAliases(erased.proof, 6);
  await erasePersonProfileAliases(access, relay, erased.proof, sealed);
  const live = await principal();
  const actor = (await provision(live)).person;
  const realm = native();
  const scope = `governance:realm:${realm}`;
  const action = 'realm.settings.manage';
  await grantFixtureAuthority(access, { scope, requireDispatch: false,
    representations: [{ principalId: live.id, actor, action, lifetime: 'infinity' }],
    grant: { actor, action, lifetime: 'infinity' } });
  const admission = new AccessAdmissionRegistry(access);
  const aliases = new AliasRegistry(access);
  const holder = native();
  const claim = (alias: string) => admission.withOwnerAuthority({ principal: live, actingSubject: actor, scope, action },
    client => aliases.write(client, live, { scope: 'space', holder, actingSubject: actor,
      operation: 'claim', alias, expectedRevision: null, idempotencyKey: randomUUID() }, actor));
  await expect(claim(copies.key)).rejects.toBeInstanceOf(AliasConflict);
  expect((await access.query("SELECT 1 FROM access.alias_registry WHERE scope='space' AND holder=$1", [holder])).rowCount).toBe(0);
  expect(await claim(`newspace${randomUUID().slice(0,8)}`)).toMatchObject({ holder, scope: 'space', state: 'current' });
});


test('report intake cannot commit an author or Account hold while the Person graph owner has its fence', async () => {
  const { proof } = await endedFixture();
  const resource = native();
  const reports = new PublicReports(access, { resolve: async () => ({
    evidence: { owner: 'content', resource, component: 'body', locator: null,
      revision: randomUUID(), state: 'available', representation: 'content-body-v1',
      revisionDigest: 'b'.repeat(64), provenance: {} }, author: proof.person, realm: null,
  }) });
  await withPersonProfileErasureAuthority(access, relay, proof, async () => {
    // This callback is the fence used by the graph applier across databases.
    // Intake must time out on the same fence, never commit a hold after its check.
    await expect(reports.submit({ profile: 'public-report-v1', category: 'child_exploitation',
      target: resource, statement: 'Preserve reported material.', contentLanguage: 'en' }, randomUUID(),
    new Request('http://main.test/v1/public-reports'), null)).rejects.toBeInstanceOf(GovernanceUnavailable);
    expect((await access.query(`SELECT 1 FROM access.governance_preservation_hold
      WHERE target_resource = $1 AND released_at IS NULL`, [resource])).rowCount).toBe(0);
  });
});

function preservedTarget(author: string, resource = native()): ReportTarget {
  return { evidence: { owner: 'content', resource, component: 'body', locator: null,
    revision: randomUUID(), state: 'available', representation: 'content-body-v1',
    revisionDigest: 'b'.repeat(64), provenance: {} }, author, realm: null };
}
function submitSafetyReport(reports: PublicReports, target: string, key = randomUUID()) {
  return reports.submit({ profile: 'public-report-v1', category: 'child_exploitation', target,
    statement: 'Preserve reported material.', contentLanguage: 'en' }, key,
  new Request('http://main.test/v1/public-reports'), null);
}
async function materialHolds(resource: string) {
  return (await access.query(`SELECT author_subject, account_issuer, account_subject
    FROM access.governance_preservation_hold WHERE target_resource = $1 AND released_at IS NULL`, [resource])).rows;
}

test('intake first commits its exact author and Account hold and refuses the Person destruction decision', async () => {
  const { owner, profile, proof } = await endedFixture();
  const target = preservedTarget(proof.person);
  let entered!: () => void;
  let release!: () => void;
  const locked = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const reports = new PublicReports(access, { resolve: async () => {
    if (++reads === 2) { entered(); await proceed; }
    return target;
  } });
  const intake = submitSafetyReport(reports, target.evidence.resource);
  await locked;
  let dispatched = false;
  const erasure = withPersonProfileErasureAuthority(access, relay, proof, async () => { dispatched = true; })
    .then(() => null, (error: unknown) => error);
  release();
  const receipt = await intake;
  expect(await erasure).toBeInstanceOf(PersonProfileErasureDenied);
  expect(dispatched).toBe(false);
  expect(await materialHolds(target.evidence.resource)).toEqual([{ author_subject: proof.person,
    account_issuer: owner.issuer, account_subject: owner.subject }]);
  expect((await provisionRow(profile.id)).display_name).toBe(profile.displayName);
  expect((await access.query('SELECT 1 FROM access.governance_report WHERE id=$1', [receipt.reportId])).rowCount).toBe(1);
});

test('erasure first wins an in-flight Person intake and the re-admission refuses erased material without a hold', async () => {
  const { profile, proof } = await endedFixture();
  const target = preservedTarget(proof.person, proof.person);
  let reads = 0;
  const reports = new PublicReports(access, { resolve: async () => {
    const erased = (await provisionRow(profile.id)).profile_erasure_id !== null;
    if (++reads === 1) {
      expect(erased).toBe(false);
      // Finish the real owner after intake's initial read, before it has a fence.
      await erasePersonProvisionProfile(access, relay, proof);
    }
    return { ...target, evidence: { ...target.evidence, state: erased ? 'erased' : 'available' } };
  } });
  await expect(submitSafetyReport(reports, proof.person)).rejects.toBeInstanceOf(GovernanceConflict);
  expect(reads).toBe(2);
  expect(await personProvisionProfileErased(access, proof)).toBe(true);
  expect(await materialHolds(proof.person)).toEqual([]);
  expect((await access.query('SELECT 1 FROM access.governance_case WHERE target_resource=$1', [proof.person])).rowCount).toBe(0);
});

test('a surviving Work can acquire an author hold after Person sanitation without restoring the erased profile', async () => {
  const { owner, proof } = await endedFixture();
  await erasePersonProvisionProfile(access, relay, proof);
  const target = preservedTarget(proof.person);
  const reports = new PublicReports(access, { resolve: async () => target });
  await submitSafetyReport(reports, target.evidence.resource);
  expect(await personProvisionProfileErased(access, proof)).toBe(true);
  expect(await materialHolds(target.evidence.resource)).toEqual([{ author_subject: proof.person,
    account_issuer: owner.issuer, account_subject: owner.subject }]);
});

test('an Account hold through another Person waits for the original Person destruction decision', async () => {
  const { proof, sibling } = await endedFixture({ sibling: true });
  const target = preservedTarget(sibling!.person);
  const reports = new PublicReports(access, { resolve: async () => target });
  await withPersonProfileErasureAuthority(access, relay, proof, async () => {
    await expect(submitSafetyReport(reports, target.evidence.resource)).rejects.toBeInstanceOf(GovernanceUnavailable);
    expect(await materialHolds(target.evidence.resource)).toEqual([]);
  });
});

test('safety intake refuses an already erased target and changed author, revision or Realm before inserting a hold', async () => {
  const { proof } = await endedFixture();
  const target = preservedTarget(proof.person);
  const changed: ReportTarget[] = [
    { ...target, author: native() },
    { ...target, evidence: { ...target.evidence, revision: randomUUID() } },
    { ...target, realm: native() },
  ];
  for (const current of changed) {
    let reads = 0;
    const reports = new PublicReports(access, { resolve: async () => ++reads === 1 ? target : current });
    await expect(submitSafetyReport(reports, target.evidence.resource)).rejects.toBeInstanceOf(GovernanceConflict);
  }
  const erased: ReportTarget = { ...target, evidence: { ...target.evidence, state: 'erased' } };
  await expect(submitSafetyReport(new PublicReports(access, { resolve: async () => erased }),
    target.evidence.resource)).rejects.toBeInstanceOf(GovernanceDenied);
  expect(await materialHolds(target.evidence.resource)).toEqual([]);
});

test('authenticated Accounts reporting each others Works both commit without a principal lock cycle', async () => {
  const a = await principal();
  const b = await principal();
  const authorA = await provision(a);
  const authorB = await provision(b);
  const targets = [preservedTarget(authorB.person), preservedTarget(authorA.person)];
  let release!: () => void;
  const initialReads = new Promise<void>(resolve => { release = resolve; });
  let ready = 0;
  const reports = targets.map(target => {
    let reads = 0;
    return new PublicReports(access, { resolve: async () => {
      if (++reads === 1) {
        if (++ready === 2) release();
        await initialReads;
      } else {
        // Both intakes overlap their owner read while any principal locks remain held.
        await new Promise<void>(resolve => { setImmediate(resolve); });
      }
      return target;
    } });
  });
  const outcomes = await Promise.allSettled(reports.map((report, index) => report.submit({
    profile: 'public-report-v1', category: 'child_exploitation', target: targets[index]!.evidence.resource,
    statement: 'Preserve reported material.', contentLanguage: 'en',
  }, randomUUID(), new Request('http://main.test/v1/public-reports'), index === 0 ? a : b)));
  expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
  expect(await materialHolds(targets[0]!.evidence.resource)).toEqual([{ author_subject: authorB.person,
    account_issuer: b.issuer, account_subject: b.subject }]);
  expect(await materialHolds(targets[1]!.evidence.resource)).toEqual([{ author_subject: authorA.person,
    account_issuer: a.issuer, account_subject: a.subject }]);
});
