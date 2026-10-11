import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable, engageAccessRecoveryFence,
  releaseAccessRecoveryFence, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { AccessAgentControl } from '../src/modules/access/agent-control.ts';
import { ensureFixtureScopeGate, grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { AccessPolicyChanges } from '../src/modules/access/policy-changes.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkMaintainers } from '../src/modules/work/maintainers.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4, connectionTimeoutMillis: 1000 });
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
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

async function principal() {
  const id = randomUUID();
  const verified: VerifiedPrincipal = {
    issuer: 'https://account.rezics.test', subject: randomUUID(), emailVerified: true,
  };
  verified.currentAssertion = async () => verified;
  await pool.query('INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [id, verified.issuer, verified.subject]);
  return { id, verified };
}

async function authority(who: Awaited<ReturnType<typeof principal>>, actor: string, scope: string,
  action: string) {
  return grantFixtureAuthority(pool, {
    scope, requireDispatch: false,
    representations: [{ principalId: who.id, actor, action, lifetime: 'infinity' }],
    grant: { actor, action, lifetime: 'infinity' },
  });
}

async function agent(controllers: Awaited<ReturnType<typeof principal>>[], kind = 'person') {
  const actor = native();
  await pool.query("INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')", [actor]);
  const mandates = [];
  for (const who of controllers) {
    const result = await authority(who, actor, `agent:control:${actor}`, 'agent.control');
    const mandate = (await pool.query<{ id: string; generation: string }>(
      'SELECT id,generation::text FROM access.representation WHERE id = $1',
      [result.representationIds[0]])).rows[0]!;
    mandates.push(mandate);
  }
  const provision = randomUUID();
  await pool.query(`INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
    agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1::uuid,$2,$1::text,$3,$4,$5,'Preview fixture',0,'active','fixture',1,$6)`,
  [provision, controllers[0]!.id, digest(provision), actor, kind, mandates[0]!.id]);
  return { actor, mandates };
}

/** Graph provenance is an external owner boundary; Access uses real migrations,
 * maintainership, controller changes, policy publication and recovery fences.
 * The graph fixture refuses public authority for this private native Work. */
async function fixture(kind = 'person') {
  const owner = await principal();
  const control = await agent([owner], kind);
  const work = native(), mainVersion = native(), admission = randomUUID();
  const receipt = `urn:rezics:receipt:${digest(admission)}`;
  await ensureFixtureScopeGate(pool, 'work:create:root');
  await pool.query(`INSERT INTO access.admission (id,principal_id,acting_subject,scope_id,action,
    idempotency_key,request_digest,authority_epoch,expires_at,state,graph_receipt,graph_outcome,
    graph_data_epoch,graph_sequence,sealed_at) VALUES ($1::uuid,$2,$3,'work:create:root','work.create',
    $1::text,$4,0,now(),'sealed',$5,'succeeded','fixture','1',now())`,
  [admission, owner.id, control.actor, digest(admission), receipt]);
  await pool.query('INSERT INTO access.work_maintainer_set (work,main_version,creation_admission) VALUES ($1,$2,$3)',
    [work, mainVersion, admission]);
  await pool.query('INSERT INTO access.work_maintainer (work,agent,owner) VALUES ($1,$2,true)', [work, control.actor]);
  const queries: string[] = [];
  let receiptCurrent = true;
  const graph = { query: async (query: string) => {
    queries.push(query);
    if (query.includes('rv:disclosure rv:Public')) return { boolean: false };
    if (query.includes('rv:admissionId')) return { boolean: receiptCurrent && query.includes(receipt) };
    return { boolean: true };
  } } as unknown as Pick<FusekiClient, 'query'>;
  const registry = new AccessAdmissionRegistry(pool);
  registry.configureBaseline(graph);
  const scope = `work:read:${work}`;
  const read = (who = owner, actor = control.actor) => registry.canReadWork(who.verified, actor, work);
  return { owner, control, work, mainVersion, graph, registry, scope, read, queries,
    loseReceipt: () => { receiptCurrent = false; } };
}

test('private PREVIEW belongs to current native Work maintainer rows without individual work.read grants', async () => {
  const f = await fixture();
  expect(await f.read()).toBe(true);
  expect((await pool.query('SELECT id FROM access.permission_grant WHERE scope_id = $1 AND action = $2',
    [f.scope, 'work.read'])).rowCount).toBe(0);
  const other = await principal();
  const otherAgent = await agent([other]);
  expect(await f.read(other, otherAgent.actor)).toBe(false);
  expect(await f.registry.canReadWork(f.owner.verified, f.control.actor, native())).toBe(false);
  expect(f.queries.some(query => query.includes('rv:admissionId'))).toBe(true);
});

test('private PREVIEW accepts a represented organization maintainer, never membership without control', async () => {
  const f = await fixture('organization');
  expect(await f.read()).toBe(true);
  const member = await principal();
  await authority(member, f.control.actor, f.scope, 'work.edit');
  expect(await f.read(member)).toBe(false);
});

test('private PREVIEW belongs to represented maintainer rows as well as the owner row', async () => {
  const f = await fixture();
  const colleague = await principal();
  const colleagueAgent = await agent([colleague]);
  const maintainers = new WorkMaintainers(pool, { fuseki: f.graph,
    lineage: { dataEpoch: 'fixture', routingEpoch: 'fixture' } } as WorkActivationEnvironment);
  await maintainers.change(f.owner.verified, { work: f.work, actingSubject: f.control.actor,
    target: colleagueAgent.actor, action: 'add', expectedGeneration: '0' }, randomUUID());
  expect(await f.read(colleague, colleagueAgent.actor)).toBe(true);
  expect((await pool.query('SELECT owner FROM access.work_maintainer WHERE work = $1 AND agent = $2',
    [f.work, colleagueAgent.actor])).rows[0]!.owner).toBe(false);
});

test('private PREVIEW requires verified identity and current authored native provenance', async () => {
  const f = await fixture();
  expect(await f.registry.canReadWork({ ...f.owner.verified, emailVerified: false }, f.control.actor, f.work)).toBe(false);
  expect(await f.registry.canReadWork(f.owner.verified, f.control.actor, 'https://other.example/work')).toBe(false);
  f.loseReceipt();
  expect(await f.read()).toBe(false);
});

test('private PREVIEW preserves closed scope gates and recovery holds with symmetric restoration', async () => {
  const f = await fixture();
  await ensureFixtureScopeGate(pool, f.scope);
  await pool.query('UPDATE access.scope_gate SET open = false WHERE id = $1', [f.scope]);
  expect(await f.read()).toBe(false);
  await pool.query('UPDATE access.scope_gate SET open = true WHERE id = $1', [f.scope]);
  expect(await f.read()).toBe(true);
  const generation = await engageAccessRecoveryFence(pool);
  try { await expect(f.read()).rejects.toBeInstanceOf(AdmissionUnavailable); }
  finally { await releaseAccessRecoveryFence(pool, generation); }
  expect(await f.read()).toBe(true);
});

test('private PREVIEW revokes former maintainer and controller authority after transfer', async () => {
  const f = await fixture();
  const next = await principal();
  const target = await agent([next]);
  const maintainers = new WorkMaintainers(pool, { fuseki: f.graph,
    lineage: { dataEpoch: 'fixture', routingEpoch: 'fixture' } } as WorkActivationEnvironment);
  expect(await f.read()).toBe(true);
  await maintainers.change(f.owner.verified, { work: f.work, actingSubject: f.control.actor,
    target: target.actor, action: 'transfer', expectedGeneration: '0' }, randomUUID());
  expect(await f.read()).toBe(false);
  expect(await f.read(next, target.actor)).toBe(true);
  const replacement = await principal();
  await authority(replacement, target.actor, `agent:control:${target.actor}`, 'agent.control');
  await new AccessAgentControl(pool).removeController(replacement.verified, {
    idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()),
  }, { subjectId: target.actor, representationId: target.mandates[0]!.id,
    expectedGeneration: target.mandates[0]!.generation });
  expect(await f.read(next, target.actor)).toBe(false);
  expect(await f.read(replacement, target.actor)).toBe(true);
});

async function policy(f: Awaited<ReturnType<typeof fixture>>, effect: 'allow' | 'deny') {
  await authority(f.owner, f.control.actor, f.scope, 'access.policy.manage');
  const epoch = (await pool.query('SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1',
    [f.scope])).rows[0]!.authority_epoch;
  await new AccessPolicyChanges(pool).change({ principal: f.owner.verified, issuerSubject: f.control.actor,
    expectedAuthorityEpoch: epoch, idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()) }, {
    action: 'publish-revision', policyId: randomUUID(), scopeId: f.scope, expectedHeadRevision: '0',
    mandatory: [], ordered: [{ ruleId: randomUUID(), actions: ['work.read'], effect,
      condition: { op: 'authenticated' } }],
  });
}

test('private PREVIEW respects explicit-policy precedence: explicit deny wins even with individual grants', async () => {
  const f = await fixture();
  await authority(f.owner, f.control.actor, f.scope, 'work.read');
  expect(await f.read()).toBe(true);
  await policy(f, 'deny');
  expect(await f.read()).toBe(false);
});

test('private PREVIEW respects explicit-policy precedence: allow cannot manufacture a missing read grant', async () => {
  const f = await fixture();
  await policy(f, 'allow');
  expect(await f.read()).toBe(false);
  await authority(f.owner, f.control.actor, f.scope, 'work.read');
  expect(await f.read()).toBe(true);
});
