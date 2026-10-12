import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { FusekiClient, type CommandEnvelope, type TemplateIndexDelta } from '../src/infrastructure/fuseki.ts';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { AccessAdmissionRegistry, AdmissionDenied, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority, ensureFixtureScopeGate } from '../src/modules/access/fixture-authority.ts';
import { AccessRealmRoster } from '../src/modules/access/roster.ts';
import { settleRealmPolicy } from '../src/modules/access/realm-management-recovery.ts';
import { accessClient, controlTransaction } from '../src/modules/access/topology-control.ts';
import { TemplateSeekIndex } from '../src/modules/query/seek-index.ts';
import { GovernanceStore, GovernanceConflict, GovernanceStale, GLOBAL_CONTEXT, type DecisionInput } from '../src/modules/governance/store.ts';
import { ReviewReportOwner } from '../src/modules/governance/report-review.ts';
import { PublicReports } from '../src/modules/public-report/store.ts';
import { withPreservationFence } from '../src/modules/public-report/preservation.ts';
import { DisclosureStore } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { SuitabilityStore } from '../src/modules/suitability/store.ts';
import { RealmVariantRecommendationStore } from '../src/modules/work/realm-variant-recommendation.ts';
import { NativeVariantUnavailable } from '../src/modules/work/native-variants.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { workRead } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const previousMode = nestedPoolCheckoutMode();
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  setNestedPoolCheckoutMode('throw');
  cluster = await startPostgresCluster();
  pool = boundedPool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
  setNestedPoolCheckoutMode(previousMode);
}, 60_000);

async function identity() {
  const principalId = randomUUID(), actor = native(), realm = native(), work = native();
  const principal: VerifiedPrincipal = { issuer: 'https://account.owner.test', subject: randomUUID() };
  await pool.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent'),($2,'institution')", [actor, realm]);
  const grant = (action: string, scope: string) => grantFixtureAuthority(pool, { scope, requireDispatch: true,
    representations: [{ principalId, actor, action, lifetime: 'infinity' }],
    grant: { actor, action, lifetime: 'infinity' } });
  return { principal, principalId, actor, realm, work, grant, access: new AccessAdmissionRegistry(pool) };
}

async function heldTransaction() {
  const client = accessClient(pool);
  expect(client).toBeDefined();
  await expect(pool.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
  const id = (await client!.query('SELECT txid_current()::text AS id')).rows[0]!.id as string;
  return { client: client!, id };
}

async function sameTransaction(client: PoolClient, id: string) {
  expect(accessClient(pool)).toBe(client);
  expect((await client.query('SELECT txid_current()::text AS id')).rows[0]!.id).toBe(id);
}

function publicationStore() {
  return new GovernanceStore(pool, {} as never, {} as never, {} as never);
}

test('the actual public Realm roster preserves names under its one held Realm client', async () => {
  const f = await identity();
  const authority = await f.grant('agent.control', `agent:control:${f.actor}`);
  await ensureFixtureScopeGate(pool, `governance:realm:${f.realm}`);
  await pool.query("INSERT INTO access.membership_policy(kind,owner_subject,revision,terms_revision) VALUES ('realm',$1,1,'terms')", [f.realm]);
  const membership = randomUUID();
  await pool.query(`INSERT INTO access.membership(id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
    VALUES ($1,'realm',$2,$3,'joined',1,1,'terms','consent')`, [membership, f.realm, f.actor]);
  await pool.query(`INSERT INTO access.realm_roster_listing(membership_id,membership_generation,realm,member,listed)
    VALUES ($1,1,$2,$3,true)`, [membership, f.realm, f.actor]);
  await pool.query(`INSERT INTO access.agent_provision(id,principal_id,idempotency_key,request_digest,agent_id,
    agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1,$2,$6,$3,$4,'person','Visible member',0,'active','epoch',1,$5)`,
  [randomUUID(), f.principalId, 'a'.repeat(64), f.actor, authority.representationIds[0], randomUUID()]);
  let policyReads = 0;
  const graph = { query: async () => {
    await heldTransaction();
    policyReads++;
    return { results: { bindings: [{ space: { type: 'uri', value: native() },
      disclosure: { type: 'uri', value: 'https://rezics.com/vocab/Public' } }] } };
  } } as unknown as FusekiClient;
  const roster = new AccessRealmRoster(pool, { fuseki: graph, objectDirectory: '.temp/access-owner-checkout',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'epoch' } });
  expect((await roster.read(f.realm, {})).items).toEqual([{ agent: f.actor, displayName: 'Visible member', featured: false }]);
  expect(policyReads).toBe(2);
  await pool.query('UPDATE access.authority_subject SET active=false WHERE id=$1', [f.actor]);
  expect((await roster.read(f.realm, {})).items).toEqual([]);
  expect(accessClient(pool)).toBeUndefined();
}, 30_000);

for (const signed of [false, true]) {
  test(`child-exploitation intake re-resolves ${signed ? 'signed' : 'anonymous'} disclosure under its actual owner and rejects moved targets`, async () => {
    const f = await identity();
    const reader = new DisclosureStore(pool);
    const resource = native();
    const graph = { query: async () => ({ results: { bindings: [{ epoch: { type: 'literal', value: 'reports' },
      sequence: { type: 'literal', value: '1' } }] } }) } as unknown as FusekiClient;
    const deps = { environment: { fuseki: graph, objectDirectory: '.temp/access-owner-checkout',
      lineage: { dataEpoch: 'reports', routingEpoch: 'reports' } }, access: f.access,
      account: { verify: async () => f.principal } } as unknown as MainWorkDependencies;
    const request = () => new Request('http://main.test/v1/public-reports', signed
      ? { headers: { authorization: 'Bearer fixture' } } : {});
    let resolves = 0, moved = false;
    const reports = new PublicReports(pool, { resolve: async (_input, request, principal) => {
      resolves++;
      if (resolves % 2 === 0) await heldTransaction();
      expect(await workRead(deps, request, principal ? { actingSubject: f.actor } : {},
        async session => session.principal?.subject ?? null)).toBe(signed ? f.principal.subject : null);
      const target = { owner: 'content' as const, resource, component: 'body' as const };
      expect(await reader.read([target], ANONYMOUS_VIEWER, 'thread')).toEqual(['visible']);
      return { evidence: { ...target, resource: moved && resolves % 2 === 0 ? native() : resource,
        locator: null, revision: randomUUID(), state: 'available' as const,
        representation: 'content-body-v1', revisionDigest: 'b'.repeat(64), provenance: {} }, author: f.actor, realm: null };
    } });
    const input = { profile: 'public-report-v1' as const, category: 'child_exploitation' as const,
      target: resource, statement: 'Preserve the reported material.', contentLanguage: 'en' };
    const result = await reports.submit(input, randomUUID(), request(), signed ? f.principal : null);
    expect(result.replayed).toBe(false);
    expect(resolves).toBe(2);
    moved = true;
    await expect(reports.submit(input, randomUUID(), request(), signed ? f.principal : null))
      .rejects.toBeInstanceOf(GovernanceConflict);
    expect((await pool.query('SELECT id FROM access.governance_report WHERE case_id=$1', [result.caseId])).rowCount).toBe(1);
    expect(accessClient(pool)).toBeUndefined();
  }, 30_000);
}

test('recommendation eligibility discloses on its owner client and ineligible callbacks roll back receipts', async () => {
  const f = await identity();
  await f.grant('publication.adopt', `publication:adopt:${f.realm}`);
  const store = new RealmVariantRecommendationStore(pool), reader = new DisclosureStore(pool);
  const mainVersion = native(), contribution = native();
  const input = { realm: f.realm, mainVersion, contribution, expectedRevision: null,
    actingSubject: f.actor, idempotencyKey: randomUUID() };
  const eligible = async () => {
    const { client, id } = await heldTransaction();
    expect(await reader.read([{ owner: 'content', resource: contribution, component: 'body' }], ANONYMOUS_VIEWER, 'thread')).toEqual(['visible']);
    await sameTransaction(client, id);
    return true;
  };
  const result = await store.set(f.principal, input, eligible);
  expect(result.recommendation?.contribution).toBe(contribution);
  expect((await store.set(f.principal, input, async () => { throw new Error('Replay must not read eligibility'); })).replayed).toBe(true);
  const refused = { ...input, mainVersion: native(), idempotencyKey: randomUUID() };
  await expect(store.set(f.principal, refused, async () => { await eligible(); return false; })).rejects.toBeInstanceOf(NativeVariantUnavailable);
  expect((await pool.query('SELECT 1 FROM access.realm_native_variant_recommendation_receipt WHERE idempotency_key=$1', [refused.idempotencyKey])).rowCount).toBe(0);
  expect(accessClient(pool)).toBeUndefined();
}, 30_000);

test('author suitability enters the real Work edit owner and nested control transaction without committing the parent', async () => {
  const f = await identity();
  await f.grant('work.edit', `work:edit:${f.work}`);
  const store = new SuitabilityStore(pool, f.access);
  const target = { resource: f.work, base: 'work' as const, types: ['https://schema.org/CreativeWork'],
    work: f.work, revision: native(), disclosure: 'restricted' as const };
  const input = { actingSubject: f.actor, expectedRevision: null, labels: [] as [], basis: 'author' as const };
  const key = randomUUID();
  await expect(f.access.withWorkEditAuthority(f.principal, f.actor, f.work, async () => {
    const { client, id } = await heldTransaction();
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query("SET LOCAL statement_timeout='1s'");
    const result = await store.write(f.principal, target, input, key);
    expect(result.assessment.status).toBe('assessed');
    expect((await client.query('SHOW lock_timeout')).rows[0]?.lock_timeout).toBe('500ms');
    expect((await client.query('SHOW statement_timeout')).rows[0]?.statement_timeout).toBe('1s');
    await sameTransaction(client, id);
    throw new Error('Authority caller rolls back');
  })).rejects.toThrow('Authority caller rolls back');
  expect((await pool.query('SELECT 1 FROM access.suitability_assessment WHERE target=$1', [f.work])).rowCount).toBe(0);
  expect((await store.write(f.principal, target, input, key)).replayed).toBe(false);
  await expect(f.access.withWorkEditAuthority({ ...f.principal, subject: 'absent' }, f.actor, f.work,
    async () => { throw new Error('Unauthorized callback ran'); })).rejects.toBeInstanceOf(AdmissionDenied);
  expect(accessClient(pool)).toBeUndefined();
}, 30_000);

test('publication fence contributor admission reads uncommitted owner rows and retains unknown-contributor refusal', async () => {
  const f = await identity();
  await f.grant('work.create', 'work:create:root');
  const admission = await f.access.register({ principal: f.principal, actingSubject: f.actor,
    action: 'work.create', scope: 'work:create:root', idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
  const store = publicationStore();
  const marker = randomUUID();
  await expect(store.withPublicationFence([f.work], async allowed => {
    expect(allowed).toBe(true);
    const { client, id } = await heldTransaction();
    expect(await f.access.admittedActingSubject(admission.id)).toBe(f.actor);
    expect((await client.query('SHOW statement_timeout')).rows[0]?.statement_timeout).toBe('5s');
    await client.query("SET LOCAL statement_timeout='1700ms'");
    await expect(f.access.admittedActingSubject(randomUUID())).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await client.query('SHOW statement_timeout')).rows[0]?.statement_timeout).toBe('1700ms');
    await client.query('INSERT INTO access.template_seek_pending(epoch,sequence,id,delta) VALUES ($1,1,$2,$3)', [marker, 'rollback', { bases: [] }]);
    await sameTransaction(client, id);
    throw new Error('Publication failed');
  })).rejects.toThrow('Publication failed');
  expect((await pool.query('SELECT 1 FROM access.template_seek_pending WHERE epoch=$1', [marker])).rowCount).toBe(0);
  expect(await store.withPublicationFence([f.work], async () => f.access.admittedActingSubject(admission.id))).toBe(f.actor);
}, 30_000);

/** Only the committed transport is deterministic. The Fuseki command adapter
 * invokes its genuinely attached TemplateSeekIndex, which writes PostgreSQL. */
function indexedGraph() {
  const epoch = randomUUID();
  const committed = new Map<string, TemplateIndexDelta>();
  const envelopes: CommandEnvelope[] = [];
  let empty = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const envelope = await request.json() as CommandEnvelope;
    envelopes.push(envelope);
    let delta = committed.get(envelope.receipt);
    if (!delta) {
      delta = { position: { dataEpoch: epoch, sequence: String(committed.size + 1) }, bases: [],
        entities: empty ? [] : [{ graph: 'urn:rezics:graph:current', id: native(), terms: { type: ['https://rezics.com/vocab/AuthorCredit'] } }] };
      committed.set(envelope.receipt, delta);
    }
    return Response.json({ status: 'committed', position: { datasetId: 'nested-test', ...delta.position }, templateIndex: delta });
  } });
  const graph = new FusekiClient(`http://127.0.0.1:${server.port}/rezics/`);
  const index = new TemplateSeekIndex(pool, graph);
  graph.commandHealth = async () => ({ moduleVersion: 'test', instanceId: 'test',
    publicSearchWriteEpoch: epoch, publicSearchWriteActive: true, profiles: Object.fromEntries(
    Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) });
  const env: WorkActivationEnvironment = { fuseki: graph, objectDirectory: '.temp/access-owner-checkout',
    lineage: { dataEpoch: epoch, routingEpoch: epoch } };
  const command = async (receipt = `urn:rezics:receipt:${randomUUID()}`) => {
    const { client, id } = await heldTransaction();
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 931))', [epoch]);
    expect((await graph.command({ receipt, digest: 'a'.repeat(64), update: 'INSERT DATA {}', validations: [], deadlineMs: 1_000 })).status).toBe('committed');
    await sameTransaction(client, id);
    expect((await client.query("SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted")).rowCount).toBeGreaterThan(0);
    expect((await client.query('SELECT 1 FROM access.template_seek_pending WHERE epoch=$1', [epoch])).rowCount).toBe(0);
    return receipt;
  };
  return { env, graph, index, epoch, committed, envelopes, command,
    empty: () => { empty = true; }, stop: () => server.stop(true) };
}

for (const owner of ['Realm placement permit', 'preservation erasure', 'publication fence'] as const) {
  test(`${owner} retains its lock and transaction through the attached graph index, including empty/replayed deltas and failure`, async () => {
    const f = await identity();
    await f.grant('realm.owner', `governance:realm:${f.realm}`);
    const graph = indexedGraph();
    const store = publicationStore();
    const run = (callback: () => Promise<string>) => owner === 'Realm placement permit'
      ? f.access.withRealmPolicy(f.principal, f.actor, f.realm, 'reply', callback)
      : owner === 'preservation erasure'
        ? withPreservationFence(pool, f.work, randomUUID(), callback)
        : store.withPublicationFence([f.work], async allowed => { expect(allowed).toBe(true); return callback(); });
    try {
      let receipt = '';
      await run(async () => { receipt = await graph.command(); return receipt; });
      await run(() => graph.command(receipt));
      graph.empty();
      await run(() => graph.command());
      const marker = randomUUID();
      await expect(run(async () => {
        await graph.command();
        await accessClient(pool)!.query('INSERT INTO access.template_seek_pending(epoch,sequence,id,delta) VALUES ($1,1,$2,$3)',
          [marker, 'rollback', { bases: [] }]);
        throw new Error('Owner callback failed');
      })).rejects.toThrow('Owner callback failed');
      expect((await pool.query('SELECT 1 FROM access.template_seek_pending WHERE epoch=$1', [marker])).rowCount).toBe(0);
      expect(accessClient(pool)).toBeUndefined();
      await run(() => graph.command());
    } finally { await graph.stop(); }
  }, 30_000);
}

test('Realm policy recovery publishes the held delivery client through a committed indexed command and retry', async () => {
  const f = await identity();
  const graph = indexedGraph();
  const receipt = randomUUID();
  await ensureFixtureScopeGate(pool, `governance:realm:${f.realm}`);
  await controlTransaction(pool, async client => {
    await client.query(`INSERT INTO access.realm_admin_receipt
      (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
      VALUES ($1,$2,$3,$4,$6,$5,'realm.settings','Publish policy','{}')`,
    [receipt, f.realm, f.principalId, f.actor, 'a'.repeat(64), randomUUID()]);
    await client.query(`INSERT INTO access.realm_policy_delivery(realm,receipt_id,generation,visibility,review_mode)
      VALUES ($1,$2,1,'public','open')`, [f.realm, receipt]);
  });
  let fail = true, asks = 0;
  graph.graph.query = async query => {
    if (query.includes('ASK')) return { boolean: ++asks % 2 === 0 && !fail };
    return { results: { bindings: [{ space: { type: 'uri', value: f.work } }] } };
  };
  // Fail after the real attached writer consumes the committed delta, so the
  // next Access attempt must repair it by replaying the exact graph receipt.
  const command = graph.graph.command.bind(graph.graph);
  graph.graph.command = async envelope => {
    const { client, id } = await heldTransaction();
    const result = await command(envelope);
    await sameTransaction(client, id);
    if (fail) throw new Error('Lost policy acknowledgement');
    return result;
  };
  try {
    await expect(settleRealmPolicy(pool, f.realm, graph.env)).rejects.toThrow('Realm policy publication is pending');
    expect((await pool.query('SELECT delivered FROM access.realm_policy_delivery WHERE realm=$1', [f.realm])).rows[0]?.delivered).toBe(false);
    expect(accessClient(pool)).toBeUndefined();
    fail = false;
    asks = 0;
    expect(await settleRealmPolicy(pool, f.realm, graph.env)).toBe(true);
    expect(graph.envelopes).toHaveLength(2);
    expect(graph.envelopes[0]!.receipt).toBe(graph.envelopes[1]!.receipt);
    expect(await settleRealmPolicy(pool, f.realm, graph.env)).toBe(false);
  } finally { await graph.stop(); }
}, 30_000);

for (const kind of ['review', 'graph'] as const) {
  test(`Governance ${kind === 'review' ? 'decision head callback' : 'graph effect callback'} borrows the actual owner and preserves stale/error recovery`, async () => {
    const f = await identity();
    await f.grant('governance.moderate', 'governance:platform');
    const graph = indexedGraph();
    const reviewId = randomUUID(), revision = kind === 'review' ? randomUUID() : native();
    if (kind === 'review') await pool.query(`INSERT INTO access.reader_review
      (id,principal_id,acting_subject,context,work,main_version,rating_observation,rating_revision,rating,language,body,spoiler,revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,8,'en','Review body',false,$9)`,
    [reviewId, f.principalId, f.actor, GLOBAL_CONTEXT, f.work, native(), native(), native(), revision]);
    const reviews = new ReviewReportOwner(pool, f.access, graph.env);
    const target = { owner: kind, resource: kind === 'review' ? reviewId : f.work,
      component: kind === 'review' ? 'body' as const : 'title' as const, revision, locator: null };
    const rule = { ref: 'urn:rule:nested-owner', revision: '1', digest: 'a'.repeat(64) };
    let stale = false, heldHeads = 0, effects = 0, fail = false;
    const store = new GovernanceStore(pool, { capture: async (_principal, _actor, evidence) => ({ ...evidence,
      state: 'available', representation: 'Retained exact evidence', revisionDigest: 'b'.repeat(64), provenance: {} }) },
    { current: async probe => {
      if (accessClient(pool)) { await heldTransaction(); heldHeads++; }
      return stale ? null : kind === 'review' ? reviews.current(probe) : revision;
    } }, { current: async () => rule }, { participants: async () => [], apply: async () => {
      effects++;
      const receipt = await graph.command();
      if (fail) throw new Error('Effect unavailable');
      return { receipt };
    } }, kind === 'review' ? reviews : undefined);
    try {
      const report = await store.submitReport(f.principal, { kind: 'content_report', actingSubject: f.actor,
        authority: { kind: 'platform', scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
        target, disclosure: 'private', reasonCode: 'spam', statement: 'Review exact material.', evidence: [target], idempotencyKey: randomUUID() });
      await store.safety.claim(f.principal, f.actor, report.caseId);
      const input: DecisionInput = { caseId: report.caseId, expectedGeneration: report.caseGeneration,
        actingSubject: f.actor, outcome: 'restrict', targets: [{ ...target, scopeKind: 'exact_revision', expectedHead: revision, effect: 'disclosure' }],
        rule, evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
        rationale: null, disclosure: 'private', idempotencyKey: randomUUID(),
        reasons: { facts: 'Staff reviewed exact evidence.', scope: 'One retained revision.', duration: 'Until reconsidered.',
          automation: false, contentLanguage: 'en', appealRoute: '/v1/public-reports/{caseId}/correspondence' } };
      stale = true;
      await expect(store.decide(f.principal, input)).rejects.toBeInstanceOf(GovernanceStale);
      stale = false;
      fail = kind === 'graph';
      const first = await store.decide(f.principal, input);
      if (kind === 'graph') {
        expect(effects).toBe(1);
        fail = false;
        const replay = await store.decide(f.principal, input);
        expect(replay.decisionId).toBe(first.decisionId);
        expect(effects).toBe(2);
      } else {
        expect(heldHeads).toBeGreaterThan(0);
        expect((await store.decide(f.principal, input)).decisionId).toBe(first.decisionId);
      }
      expect(accessClient(pool)).toBeUndefined();
    } finally { await graph.stop(); }
  }, 30_000);
}
