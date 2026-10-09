import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { AccessRealmManagement } from '../src/modules/access/realm-management.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { RealmAdminDenied, RealmAdminInvalid, RealmAdminStale, RealmAdminUnavailable,
  spaceSettingsCommand } from '../src/modules/realm-admin/contract.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const uri = (value: string) => ({ type: 'uri' as const, value });
const text = (value: string) => ({ type: 'literal' as const, value });
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, connectionTimeoutMillis: 1000, max: 4 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

interface Editor { principal: VerifiedPrincipal; principalId: string; actor: string;
  admission: string; receipt: string; digest: string }
interface SpaceGraph { kind: 'zone' | 'realm'; zone: string; realm: string; owner: string;
  visibility: 'public' | 'private'; listing: 'listed' | 'unlisted'; committed: boolean }

async function editor(): Promise<Editor> {
  const principalId = randomUUID();
  const verified: VerifiedPrincipal = { issuer: 'https://account.rezics.test', subject: randomUUID(), emailVerified: true };
  verified.currentAssertion = async () => verified;
  const actor = native();
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, verified.issuer, verified.subject]);
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const mandate = randomUUID();
  await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [mandate, principalId, actor]);
  const provision = randomUUID();
  await pool.query(`INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
    agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,'person','Zone editor',0,'active','fixture',1,$5)`,
  [provision, principalId, sha(provision), actor, mandate]);
  const admission = randomUUID();
  const receipt = `urn:rezics:receipt:${sha(admission)}`;
  const digest = sha(`${admission}:intent`);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', ['space:create:root']);
  await pool.query(`INSERT INTO access.admission (id,principal_id,acting_subject,scope_id,action,
    idempotency_key,request_digest,authority_epoch,expires_at,state,graph_receipt,graph_outcome,
    graph_data_epoch,graph_sequence,sealed_at) VALUES ($1::uuid,$2,$3,'space:create:root','space.create',$1::text,$4,0,now(),'sealed',$5,'succeeded','fixture','1',now())`,
  [admission, principalId, actor, digest, receipt]);
  return { principal: verified, principalId, actor, admission, receipt, digest };
}

function graphFor(editors: Editor[]) {
  const spaces = new Map<string, SpaceGraph>();
  const commands: string[] = [];
  const committedReceipts = new Set<string>();
  let failDelivery = false;
  let loseResponse = false;
  const fuseki = new FusekiClient('http://graph.test/');
  fuseki.commandHealth = async () => ({ moduleVersion: '', instanceId: '', publicSearchWriteEpoch: '',
    publicSearchWriteActive: false, profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) });
  fuseki.query = async sparql => {
    if (sparql.includes('ASK')) {
      return { boolean: [...committedReceipts].some(receipt => sparql.includes(receipt)) };
    }
    if (sparql.includes('space:create:root')) {
      const match = editors.find(item => sparql.includes(item.actor)
        && [...spaces.entries()].some(([id, space]) => space.owner === item.actor
          && (sparql.includes(id) || sparql.includes(space.zone))));
      return { results: { bindings: match ? [{ admission: text(match.admission), receipt: uri(match.receipt),
        digest: text(match.digest) }] : [] } };
    }
    if (sparql.includes('SELECT ?realm ?zone ?profile')) {
      const id = [...spaces.keys()].find(item => sparql.includes(item));
      const space = id ? spaces.get(id) : undefined;
      if (!space) return { results: { bindings: [] } };
      return { results: { bindings: [{ ...(space.kind === 'realm' ? { realm: uri(space.realm) } : {}),
        ...(space.kind === 'zone' ? { zone: uri(space.zone),
          profile: uri('https://rezics.com/definition/space-zone-v1') } : {}) }] } };
    }
    if (sparql.includes('SELECT ?zone ?disclosure ?listing')) {
      const id = [...spaces.keys()].find(item => sparql.includes(item));
      const space = id ? spaces.get(id) : undefined;
      if (!space || space.kind !== 'zone') return { results: { bindings: [] } };
      return { results: { bindings: [{ zone: uri(space.zone),
        disclosure: uri(`${RV}${space.visibility === 'private' ? 'Private' : 'Public'}`),
        listing: text(space.listing) }] } };
    }
    return { boolean: false, results: { bindings: [] } };
  };
  fuseki.commandWithReceipt = async envelope => {
    commands.push(envelope.update);
    if (failDelivery) throw new Error('graph unavailable');
    const id = [...spaces.keys()].find(item => envelope.update.includes(item));
    const space = id ? spaces.get(id) : undefined;
    if (!space) throw new Error('missing space');
    space.visibility = envelope.update.includes('rv:disclosure rv:Private') ? 'private' : 'public';
    space.listing = envelope.update.includes('"unlisted"') ? 'unlisted' : 'listed';
    space.committed = true;
    committedReceipts.add(envelope.receipt);
    if (loseResponse) throw new Error('graph response lost');
    return { status: 'committed' as const, position: { datasetId: 'dataset', dataEpoch: 'current', sequence: '1' } };
  };
  const env = { fuseki, objectDirectory: '', lineage: { dataEpoch: 'current', routingEpoch: 'current' } } as WorkActivationEnvironment;
  return { spaces, commands, env, fail: (value: boolean) => { failDelivery = value; },
    lose: (value: boolean) => { loseResponse = value; } };
}

test('a Realm command still carries all four settings and a Zone command carries two', () => {
  const actor = native();
  expect(Value.Check(spaceSettingsCommand, { actingSubject: actor, expectedGeneration: '0', reason: 'Manage community',
    settings: { visibility: 'private', listing: 'unlisted', history: 'from-admission', admission: 'request' } })).toBe(true);
  expect(Value.Check(spaceSettingsCommand, { actingSubject: actor, expectedGeneration: '0', reason: 'Manage site',
    settings: { visibility: 'private', listing: 'unlisted' } })).toBe(true);
  expect(Value.Check(spaceSettingsCommand, { actingSubject: actor, expectedGeneration: '0', reason: 'Manage site',
    settings: { visibility: 'private', listing: 'unlisted', history: 'everything' } })).toBe(false);
});

test('Zone settings read and a Visibility and Listing change round-trips with one receipt', async () => {
  const admin = new AccessRealmManagement(pool);
  const owner = await editor();
  const stranger = await editor();
  const { spaces, commands, env } = graphFor([owner]);
  const space = native();
  const zone = native();
  spaces.set(space, { kind: 'zone', zone, realm: native(), owner: owner.actor,
    visibility: 'public', listing: 'listed', committed: false });
  const view = await admin.spaceSettings(owner.principal, space, owner.actor, env);
  expect(view).toEqual({ space, zone, generation: '0', settings: { visibility: 'public', listing: 'listed' } });
  await expect(admin.changeSpaceSettings(stranger.principal, space, { actingSubject: stranger.actor,
    expectedGeneration: '0', reason: 'Hide the site', settings: { visibility: 'private', listing: 'unlisted' } },
  randomUUID(), env)).rejects.toBeInstanceOf(RealmAdminDenied);
  expect(commands).toHaveLength(0);
  const changed = await admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
    expectedGeneration: '0', reason: 'Hide the site', settings: { visibility: 'private', listing: 'unlisted' } },
  'zone-settings-1', env);
  expect(changed).toMatchObject({ space, zone, generation: '1', replayed: false,
    settings: { visibility: 'private', listing: 'unlisted' } });
  expect(changed.receiptId).toMatch(/^[0-9a-f-]{36}$/);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain('rv:disclosure rv:Private');
  expect(commands[0]).toContain('"unlisted"');
  expect(commands[0]).toContain('rv:sequence ?next');
  expect(commands[0]).toContain('a rv:OutboxBatch');
  expect(commands[0]).toContain('a rv:RealmPolicyChangedEvent');
  const replay = await admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
    expectedGeneration: '0', reason: 'Hide the site', settings: { visibility: 'private', listing: 'unlisted' } },
  'zone-settings-1', env);
  expect(replay).toMatchObject({ ...changed, replayed: true });
  expect(commands).toHaveLength(1);
  expect(await admin.spaceSettings(owner.principal, space, owner.actor, env)).toEqual({ space, zone, generation: '1',
    settings: { visibility: 'private', listing: 'unlisted' } });
});

test('History and Admission are refused on a Zone and a stale generation does not publish', async () => {
  const admin = new AccessRealmManagement(pool);
  const owner = await editor();
  const { spaces, commands, env } = graphFor([owner]);
  const space = native();
  spaces.set(space, { kind: 'zone', zone: native(), realm: native(), owner: owner.actor,
    visibility: 'public', listing: 'listed', committed: false });
  await expect(admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
    expectedGeneration: '0', reason: 'Set Realm-only policy', settings: { visibility: 'private', listing: 'listed',
      history: 'from-admission', admission: 'invitation' } }, randomUUID(), env)).rejects.toThrow(RealmAdminInvalid);
  await expect(admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
    expectedGeneration: '4', reason: 'Hide the site', settings: { visibility: 'private', listing: 'unlisted' } },
  randomUUID(), env)).rejects.toBeInstanceOf(RealmAdminStale);
  expect(commands).toHaveLength(0);
  expect(await admin.spaceSettings(owner.principal, space, owner.actor, env)).toMatchObject({ generation: '0',
    settings: { visibility: 'public', listing: 'listed' } });
});

test('two Zone settings commands with the same generation admit one publication', async () => {
  const admin = new AccessRealmManagement(pool);
  const owner = await editor();
  const { spaces, commands, env } = graphFor([owner]);
  const space = native();
  spaces.set(space, { kind: 'zone', zone: native(), realm: native(), owner: owner.actor,
    visibility: 'public', listing: 'listed', committed: false });
  const body = { actingSubject: owner.actor, expectedGeneration: '0', reason: 'Hide the site',
    settings: { visibility: 'private' as const, listing: 'unlisted' as const } };
  const settled = await Promise.allSettled([
    admin.changeSpaceSettings(owner.principal, space, body, 'zone-settings-a', env),
    admin.changeSpaceSettings(owner.principal, space, body, 'zone-settings-b', env),
  ]);
  const fulfilled = settled.filter(item => item.status === 'fulfilled');
  const rejected = settled.filter(item => item.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RealmAdminStale);
  expect(commands).toHaveLength(1);
  expect(await admin.spaceSettings(owner.principal, space, owner.actor, env)).toMatchObject({ generation: '1',
    settings: { visibility: 'private', listing: 'unlisted' } });
});

test('a lost Zone publication retries from the same receipt without a second settings generation', async () => {
  const admin = new AccessRealmManagement(pool);
  const owner = await editor();
  const { spaces, commands, env, fail } = graphFor([owner]);
  const space = native();
  const zone = native();
  spaces.set(space, { kind: 'zone', zone, realm: native(), owner: owner.actor,
    visibility: 'public', listing: 'listed', committed: false });
  fail(true);
  await expect(admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
    expectedGeneration: '0', reason: 'Hide the site', settings: { visibility: 'private', listing: 'listed' } },
  'zone-settings-retry', env)).rejects.toBeInstanceOf(RealmAdminUnavailable);
  expect(commands).toHaveLength(1);
  fail(false);
  const recovered = await admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
    expectedGeneration: '0', reason: 'Hide the site', settings: { visibility: 'private', listing: 'listed' } },
  'zone-settings-retry', env);
  expect(recovered).toMatchObject({ generation: '1', replayed: true, settings: { visibility: 'private', listing: 'listed' } });
  expect(commands).toHaveLength(2);
  expect(await admin.spaceSettings(owner.principal, space, owner.actor, env)).toMatchObject({ generation: '1',
    settings: { visibility: 'private', listing: 'listed' } });
});

test('a committed Zone publication whose response was lost is not written again', async () => {
  const admin = new AccessRealmManagement(pool);
  const owner = await editor();
  const { spaces, commands, env, lose } = graphFor([owner]);
  const space = native();
  spaces.set(space, { kind: 'zone', zone: native(), realm: native(), owner: owner.actor,
    visibility: 'public', listing: 'listed', committed: false });
  lose(true);
  const changed = await admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
    expectedGeneration: '0', reason: 'Hide the site', settings: { visibility: 'private', listing: 'listed' } },
  'zone-settings-lost', env);
  expect(changed).toMatchObject({ generation: '1', replayed: false, settings: { visibility: 'private', listing: 'listed' } });
  expect(commands).toHaveLength(1);
  const replay = await admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
    expectedGeneration: '0', reason: 'Hide the site', settings: { visibility: 'private', listing: 'listed' } },
  'zone-settings-lost', env);
  expect(replay).toMatchObject({ generation: '1', replayed: true });
  expect(commands).toHaveLength(1);
});

test('a Realm Space still refuses publication through the Zone delivery', async () => {
  const admin = new AccessRealmManagement(pool);
  const owner = await editor();
  const { spaces, commands, env } = graphFor([owner]);
  const space = native();
  spaces.set(space, { kind: 'realm', zone: native(), realm: native(), owner: owner.actor,
    visibility: 'public', listing: 'listed', committed: false });
  await expect(admin.changeSpaceSettings(owner.principal, space, { actingSubject: owner.actor,
    expectedGeneration: '0', reason: 'Unlist Realm', settings: { visibility: 'public', listing: 'unlisted',
      history: 'everything', admission: 'invitation' } }, randomUUID(), env)).rejects.toBeInstanceOf(RealmAdminDenied);
  expect(commands).toHaveLength(0);
});
