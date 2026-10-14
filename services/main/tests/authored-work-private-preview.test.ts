import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionUnavailable, engageAccessRecoveryFence,
  releaseAccessRecoveryFence, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { AccessAgentControl } from '../src/modules/access/agent-control.ts';
import { ensureFixtureScopeGate, FixtureAuthorityDenied, grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
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
  let isPublic = false;
  const graph = { query: async (query: string) => {
    queries.push(query);
    if (query.includes('rv:disclosure rv:Public')) return { boolean: isPublic && query.includes(work) };
    if (query.includes('rv:admissionId')) return { boolean: receiptCurrent && query.includes(receipt) };
    return { boolean: true };
  } } as unknown as Pick<FusekiClient, 'query'>;
  const registry = new AccessAdmissionRegistry(pool);
  registry.configureBaseline(graph);
  const scope = `work:read:${work}`;
  const absent = native();
  const read = async (who = owner, actor = control.actor) => {
    const scalar = await registry.canReadWork(who.verified, actor, work);
    expect(await registry.canPreviewWork(who.verified, actor, work)).toBe(scalar);
    const batch = await registry.canReadWorks(who.verified, actor, [work, absent, work]);
    expect(batch).toEqual(new Set(scalar ? [work] : []));
    return scalar;
  };
  return { owner, control, work, mainVersion, graph, registry, scope, read, queries,
    loseReceipt: () => { receiptCurrent = false; }, publish: () => { isPublic = true; } };
}

test('public Work reading does not authorize peer preview while the native owner retains preview', async () => {
  const f = await fixture();
  const peer = await principal();
  const peerAgent = await agent([peer]);
  f.publish();
  expect(await f.registry.canReadWork(peer.verified, peerAgent.actor, f.work)).toBe(true);
  expect(await f.registry.canPreviewWork(peer.verified, peerAgent.actor, f.work)).toBe(false);
  expect(await f.registry.canPreviewWork(f.owner.verified, f.control.actor, f.work)).toBe(true);
});

test.each(['representation-revoked', 'representation-expired', 'grant-revoked', 'grant-expired'] as const)(
  'read-only Work preview is lost after %s even while publication stays readable', async loss => {
    const f = await fixture();
    const reader = await principal();
    const readerAgent = await agent([reader]);
    const proof = await authority(reader, readerAgent.actor, f.scope, 'work.read');
    f.publish();
    expect(await f.registry.canPreviewWork(reader.verified, readerAgent.actor, f.work)).toBe(true);
    const table = loss.startsWith('representation') ? 'representation' : 'permission_grant';
    const row = table === 'representation' ? proof.representationIds[0] : proof.grantId;
    const assignment = loss.endsWith('expired') ? "valid_until = clock_timestamp() - interval '1 second'" : 'active = false';
    await pool.query(`UPDATE access.${table} SET ${assignment}, generation = generation + 1 WHERE id = $1`, [row]);
    expect(await f.registry.canReadWork(reader.verified, readerAgent.actor, f.work)).toBe(true);
    expect(await f.registry.canPreviewWork(reader.verified, readerAgent.actor, f.work)).toBe(false);
  });

test('inactive identity cannot retain owner preview', async () => {
  const f = await fixture();
  expect(await f.read()).toBe(true);
  await pool.query('UPDATE access.principal SET active = false WHERE id = $1', [f.owner.id]);
  expect(await f.read()).toBe(false);
});

test('an unavailable Access store cannot become absent preview authority', async () => {
  const f = await fixture();
  const unavailable = new AccessAdmissionRegistry({ connect: async () => { throw new Error('Access offline'); } } as unknown as Pool);
  await expect(unavailable.canPreviewWork(f.owner.verified, f.control.actor, f.work)).rejects.toThrow('Access offline');
});

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

test('private PREVIEW refuses an unverified Account', async () => {
  const f = await fixture();
  expect(await f.registry.canReadWork({ ...f.owner.verified, emailVerified: false }, f.control.actor, f.work)).toBe(false);
  expect(await f.registry.canPreviewWork({ ...f.owner.verified, emailVerified: false }, f.control.actor, f.work)).toBe(false);
});

test('private PREVIEW refuses a non-native Work', async () => {
  const f = await fixture();
  expect(await f.registry.canReadWork(f.owner.verified, f.control.actor, 'https://other.example/work')).toBe(false);
  expect(await f.registry.canPreviewWork(f.owner.verified, f.control.actor, 'https://other.example/work')).toBe(false);
});

test('private PREVIEW refuses a provenance-lost authored native Work', async () => {
  const f = await fixture();
  expect(await f.read()).toBe(true);
  f.loseReceipt();
  expect(await f.read()).toBe(false);
});

test('private PREVIEW preserves closed scope gates and recovery holds with symmetric restoration', async () => {
  const f = await fixture();
  await ensureFixtureScopeGate(pool, f.scope);
  await ensureFixtureScopeGate(pool, f.scope, { open: false });
  expect(await f.read()).toBe(false);
  await ensureFixtureScopeGate(pool, f.scope, { open: true });
  expect(await f.read()).toBe(true);
  const generation = await engageAccessRecoveryFence(pool);
  try { await expect(f.read()).rejects.toBeInstanceOf(AdmissionUnavailable); }
  finally { await releaseAccessRecoveryFence(pool, generation); }
  expect(await f.read()).toBe(true);
});

test('fixture gate states preserve closed registrations, advance changed fences and refuse recovery holds', async () => {
  const f = await fixture();
  const gate = async () => (await pool.query<{ open: boolean; epoch: string }>(
    'SELECT open,authority_epoch::text AS epoch FROM access.scope_gate WHERE id = $1', [f.scope])).rows[0]!;
  await ensureFixtureScopeGate(pool, f.scope);
  const initial = await gate();
  await ensureFixtureScopeGate(pool, f.scope, { open: false });
  const closed = await gate();
  expect(closed).toEqual({ open: false, epoch: String(BigInt(initial.epoch) + 1n) });
  await ensureFixtureScopeGate(pool, f.scope);
  await ensureFixtureScopeGate(pool, f.scope, { open: false });
  expect(await gate()).toEqual(closed);
  await ensureFixtureScopeGate(pool, f.scope, { open: true });
  const restored = await gate();
  expect(restored).toEqual({ open: true, epoch: String(BigInt(closed.epoch) + 1n) });
  const generation = await engageAccessRecoveryFence(pool);
  try {
    await expect(ensureFixtureScopeGate(pool, f.scope, { open: false })).rejects.toBeInstanceOf(FixtureAuthorityDenied);
  } finally { await releaseAccessRecoveryFence(pool, generation); }
  expect(await gate()).toEqual(restored);
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

async function policy(f: Awaited<ReturnType<typeof fixture>>, effect: 'allow' | 'deny',
  scope = f.scope, actions: string[] = ['work.read']) {
  await authority(f.owner, f.control.actor, scope, 'access.policy.manage');
  const epoch = (await pool.query('SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1',
    [scope])).rows[0]!.authority_epoch;
  await new AccessPolicyChanges(pool).change({ principal: f.owner.verified, issuerSubject: f.control.actor,
    expectedAuthorityEpoch: epoch, idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()) }, {
    action: 'publish-revision', policyId: randomUUID(), scopeId: scope, expectedHeadRevision: '0',
    mandatory: [], ordered: [{ ruleId: randomUUID(), actions, effect,
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

test('private PREVIEW preserves a grant holder whose installed policy ALLOWS work.read', async () => {
  const f = await fixture();
  await authority(f.owner, f.control.actor, f.scope, 'work.read');
  expect(await f.read()).toBe(true);
  await policy(f, 'allow');
  expect(await f.read()).toBe(true);
});

test('private PREVIEW respects explicit-policy precedence: allow cannot manufacture a missing read grant', async () => {
  const f = await fixture();
  await policy(f, 'allow');
  expect(await f.read()).toBe(false);
  await authority(f.owner, f.control.actor, f.scope, 'work.read');
  expect(await f.read()).toBe(true);
});

type PublicationAction = 'work.publish' | 'work.withdraw-publication';
const publicationActions: PublicationAction[] = ['work.publish', 'work.withdraw-publication'];

function publicationRequest(f: Awaited<ReturnType<typeof fixture>>, action: PublicationAction,
  who = f.owner, actor = f.control.actor) {
  return { principal: who.verified, actingSubject: actor, baselineRelatedWork: f.work,
    scope: `work:publish:${f.work}`, action, idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()) };
}

test.each(publicationActions)('%s: the Work controller is admitted without individual grants or a pre-existing gate', async action => {
  const f = await fixture();
  const request = publicationRequest(f, action);
  expect((await pool.query('SELECT id FROM access.scope_gate WHERE id = $1', [request.scope])).rowCount).toBe(0);
  const admitted = await f.registry.register(request);
  expect(admitted).toMatchObject({ action, scope: request.scope, dispatchEligible: true, state: 'registered' });
  expect((await pool.query('SELECT id FROM access.scope_gate WHERE id = $1', [request.scope])).rowCount).toBe(1);
  expect((await pool.query('SELECT id FROM access.permission_grant WHERE scope_id = $1 AND action = $2',
    [request.scope, action])).rowCount).toBe(0);
  expect((await pool.query('SELECT author_work,representation_id FROM access.baseline_admission WHERE admission_id = $1',
    [admitted.id])).rows[0]).toMatchObject({ author_work: f.work, representation_id: f.control.mandates[0]!.id });
  expect(await f.registry.claim(admitted.id, request.requestDigest, f.owner.verified))
    .toMatchObject({ action, state: 'claimed', dispatchEligible: true });
  expect(f.queries.some(query => query.includes('rv:disclosure rv:Public'))).toBe(false);
});

test.each(publicationActions)('%s: a represented organization Work controller is admitted', async action => {
  const f = await fixture('organization');
  const request = publicationRequest(f, action);
  const admitted = await f.registry.register(request);
  expect(await f.registry.claim(admitted.id, request.requestDigest, f.owner.verified))
    .toMatchObject({ action, state: 'claimed', dispatchEligible: true });
});

test.each(publicationActions)('%s: an unrelated member is refused', async action => {
  const f = await fixture();
  const other = await principal();
  const otherAgent = await agent([other]);
  await expect(f.registry.register(publicationRequest(f, action, other, otherAgent.actor)))
    .rejects.toBeInstanceOf(AdmissionDenied);
});

test.each(publicationActions)('%s: a read-only representative is refused', async action => {
  const f = await fixture();
  const reader = await principal();
  await authority(reader, f.control.actor, f.scope, 'work.read');
  expect(await f.read(reader)).toBe(true);
  await expect(f.registry.register(publicationRequest(f, action, reader)))
    .rejects.toBeInstanceOf(AdmissionDenied);
});

test.each(publicationActions)('%s: an unverified Account is refused', async action => {
  const f = await fixture();
  const request = publicationRequest(f, action);
  await expect(f.registry.register({ ...request, principal: { ...request.principal, emailVerified: false } }))
    .rejects.toBeInstanceOf(AdmissionDenied);
});

test.each(publicationActions)('%s: a suspended Account is refused', async action => {
  const f = await fixture();
  await pool.query('UPDATE access.principal SET active = false,enforcement_epoch = enforcement_epoch + 1 WHERE id = $1',
    [f.owner.id]);
  await expect(f.registry.register(publicationRequest(f, action))).rejects.toBeInstanceOf(AdmissionDenied);
});

test.each(publicationActions)('%s: an installed policy deny wins over the author-work baseline and individual grants', async action => {
  const f = await fixture();
  const request = publicationRequest(f, action);
  await authority(f.owner, f.control.actor, request.scope, action);
  await policy(f, 'deny', request.scope, [action]);
  await expect(f.registry.register(request)).rejects.toBeInstanceOf(AdmissionDenied);
});

test.each(publicationActions)('%s: publication without a controller proof fails closed', async action => {
  const f = await fixture();
  const replacement = await principal();
  await authority(replacement, f.control.actor, `agent:control:${f.control.actor}`, 'agent.control');
  await new AccessAgentControl(pool).removeController(replacement.verified, {
    idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()),
  }, { subjectId: f.control.actor, representationId: f.control.mandates[0]!.id,
    expectedGeneration: f.control.mandates[0]!.generation });
  await expect(f.registry.register(publicationRequest(f, action))).rejects.toBeInstanceOf(AdmissionDenied);
});

test.each(publicationActions)('%s: a controller revoked after registration cannot dispatch', async action => {
  const f = await fixture();
  const request = publicationRequest(f, action);
  const admitted = await f.registry.register(request);
  expect(admitted.dispatchEligible).toBe(true);
  // Retain a controller for the Agent while revoking the admission's controller.
  const replacement = await principal();
  await authority(replacement, f.control.actor, `agent:control:${f.control.actor}`, 'agent.control');
  await new AccessAgentControl(pool).removeController(replacement.verified, {
    idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()),
  }, { subjectId: f.control.actor, representationId: f.control.mandates[0]!.id,
    expectedGeneration: f.control.mandates[0]!.generation });
  await expect(f.registry.claim(admitted.id, request.requestDigest, f.owner.verified))
    .rejects.toBeInstanceOf(AdmissionDenied);
});

test.each(publicationActions)('%s: a closed publication gate remains closed', async action => {
  const f = await fixture();
  const request = publicationRequest(f, action);
  await ensureFixtureScopeGate(pool, request.scope);
  await ensureFixtureScopeGate(pool, request.scope, { open: false });
  await expect(f.registry.register(request)).rejects.toBeInstanceOf(AdmissionDenied);
});
