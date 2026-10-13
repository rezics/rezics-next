import { configureFixtureDisclosureAncestry } from './support/disclosure-ancestry.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { FusekiClient, type CommandEnvelope, type TemplateIndexDelta } from '../src/infrastructure/fuseki.ts';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionUnavailable, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority, ensureFixtureScopeGate } from '../src/modules/access/fixture-authority.ts';
import { AccessRealmRoster } from '../src/modules/access/roster.ts';
import { settleRealmPolicy } from '../src/modules/access/realm-management-recovery.ts';
import { realmTransaction } from '../src/modules/access/realm-management-authority.ts';
import { inAccessTransaction, requireRecoveryOpen } from '../src/modules/access/policy-transaction.ts';
import { PolicyUnavailable } from '../src/modules/access/policy-errors.ts';
import { RealmAdminUnavailable } from '../src/modules/realm-admin/contract.ts';
import { withWorkEditAuthorityInTransaction } from '../src/modules/access/work-edit-authority.ts';
import { accessClient, ControlUnavailable, controlTransaction } from '../src/modules/access/topology-control.ts';
import { TemplateSeekIndex } from '../src/modules/query/seek-index.ts';
import { GovernanceStore, GovernanceConflict, GovernanceStale, GovernanceUnavailable, GLOBAL_CONTEXT, type DecisionInput } from '../src/modules/governance/store.ts';
import { ReviewReportOwner } from '../src/modules/governance/report-review.ts';
import { PublicReports } from '../src/modules/public-report/store.ts';
import { DisclosureStore, resolveDisclosureSelections, type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { SuitabilityStore } from '../src/modules/suitability/store.ts';
import { RealmVariantRecommendationStore } from '../src/modules/work/realm-variant-recommendation.ts';
import { NativeVariantUnavailable } from '../src/modules/work/native-variants.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { workRead } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

async function establishedTargets(targets: readonly DisclosureTarget[]) {
  const environment = { lineage: { dataEpoch: 'policy-fixture', routingEpoch: 'policy-fixture' } } as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(environment, () => undefined);
  return (await resolveDisclosureSelections(environment, targets)).map(selection => ({
    ...selection.target, ancestry: selection.ancestry,
  }));
}

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

test('policy snapshots observe recovery without pinning its row or adding a second predicate', async () => {
  const closer = new Pool({ ...cluster!.connection, max: 1 });
  try {
    await inAccessTransaction(pool, 'repeatable read', async client => {
      await requireRecoveryOpen(client, false);
      // A snapshot reader must not block the recovery owner, and keeps its
      // original view after the independently committed close.
      await closer.query('UPDATE access.recovery_fence SET open=false WHERE id');
      expect((await client.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0]!.open).toBe(true);
    });
    await expect(inAccessTransaction(pool, 'repeatable read', client => requireRecoveryOpen(client, false)))
      .rejects.toBeInstanceOf(PolicyUnavailable);
  } finally {
    await closer.query('UPDATE access.recovery_fence SET open=true WHERE id');
    await closer.end();
  }
}, 30_000);

test.each([
  ['0', '0', '0', '2s', '5s', '15s'],
  ['10s', '10s', '30s', '2s', '5s', '15s'],
  ['500ms', '1s', '10s', '500ms', '1s', '10s'],
  ['500ms', '10s', '0', '500ms', '5s', '15s'],
  ['0', '1s', '10s', '2s', '1s', '10s'],
])('explicit Work proof retains minimum bounds for lock %s, statement %s and idle %s',
async (lock, statement, idle, lockCap, statementCap, idleCap) => {
  const f = await identity();
  await f.grant('work.edit', `work:edit:${f.work}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('lock_timeout',$1,true),
      set_config('statement_timeout',$2,true), set_config('idle_in_transaction_session_timeout',$3,true)`,
    [lock, statement, idle]);
    const id = (await client.query('SELECT txid_current()::text AS id')).rows[0]!.id;
    await withWorkEditAuthorityInTransaction(client, f.principal, f.actor, f.work, async () => {
      expect((await client.query('SHOW lock_timeout')).rows[0]!.lock_timeout).toBe(lockCap);
      expect((await client.query('SHOW statement_timeout')).rows[0]!.statement_timeout).toBe(statementCap);
      expect((await client.query('SHOW idle_in_transaction_session_timeout')).rows[0]!.idle_in_transaction_session_timeout).toBe(idleCap);
      expect((await client.query('SELECT txid_current()::text AS id')).rows[0]!.id).toBe(id);
    });
  } finally { await client.query('ROLLBACK'); client.release(); }
}, 30_000);

test('editorial preflight with only BEGIN applies Work proof bounds before reading its recovery fence', async () => {
  const f = await identity();
  await f.grant('work.edit', `work:edit:${f.work}`);
  await f.grant('work.create', 'work:create:root');
  const observed: string[][] = [];
  const measured = { connect: async () => {
    const client = await pool.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('SELECT open, generation FROM access.recovery_fence')) {
        observed.push([
          (await client.query('SHOW lock_timeout')).rows[0]!.lock_timeout,
          (await client.query('SHOW statement_timeout')).rows[0]!.statement_timeout,
          (await client.query('SHOW idle_in_transaction_session_timeout')).rows[0]!.idle_in_transaction_session_timeout,
        ]);
      }
      return client.query(sql, values);
    }, release: () => client.release() };
  } } as unknown as Pool;
  await new AccessAdmissionRegistry(measured).assertAuthority({ principal: f.principal,
    actingSubject: f.actor, action: 'work.create', scope: 'work:create:root' }, f.work);
  expect(observed[0]).toEqual(['2s', '5s', '15s']);
}, 30_000);

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
    const resource = native(), revision = randomUUID();
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
      expect(await reader.read(await establishedTargets([target]), ANONYMOUS_VIEWER, 'thread')).toEqual(['visible']);
      return { evidence: { ...target, resource: moved && resolves % 2 === 0 ? native() : resource,
        locator: null, revision, state: 'available' as const,
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
    expect(await reader.read(await establishedTargets([{ owner: 'content', resource: contribution, component: 'body' }]), ANONYMOUS_VIEWER, 'thread')).toEqual(['visible']);
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
    await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
    await withWorkEditAuthorityInTransaction(client, f.principal, f.actor, f.work, async () => {
      await sameTransaction(client, id);
      expect((await client.query('SHOW lock_timeout')).rows[0]?.lock_timeout).toBe('500ms');
      expect((await client.query('SHOW statement_timeout')).rows[0]?.statement_timeout).toBe('1s');
      expect((await client.query('SHOW idle_in_transaction_session_timeout')).rows[0]?.idle_in_transaction_session_timeout).toBe('10s');
    });
    await controlTransaction(pool, async inner => {
      expect(inner).toBe(client);
      await inner.query('INSERT INTO access.template_seek_pending(epoch,sequence,id,delta) VALUES ($1,1,$2,$3)',
        [key, 'rollback', { bases: [] }]);
    });
    expect((await client.query('SHOW lock_timeout')).rows[0]?.lock_timeout).toBe('500ms');
    expect((await client.query('SHOW statement_timeout')).rows[0]?.statement_timeout).toBe('1s');
    await sameTransaction(client, id);
    throw new Error('Authority caller rolls back');
  })).rejects.toThrow('Authority caller rolls back');
  expect((await pool.query('SELECT 1 FROM access.template_seek_pending WHERE epoch=$1', [key])).rowCount).toBe(0);
  expect((await store.write(f.principal, target, input, key)).assessment.status).toBe('assessed');
  await expect(f.access.withWorkEditAuthority({ ...f.principal, subject: 'absent' }, f.actor, f.work,
    async () => { throw new Error('Unauthorized callback ran'); })).rejects.toBeInstanceOf(AdmissionDenied);
  expect(accessClient(pool)).toBeUndefined();
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

for (const owner of ['Realm placement permit', 'publication fence'] as const) {
  test(`${owner} retains its lock and transaction through the attached graph index, including empty/replayed deltas and failure`, async () => {
    const f = await identity();
    await f.grant('realm.owner', `governance:realm:${f.realm}`);
    const graph = indexedGraph();
    const store = publicationStore();
    const run = (callback: () => Promise<string>) => owner === 'Realm placement permit'
      ? f.access.withRealmPolicy(f.principal, f.actor, f.realm, 'reply', callback)
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

const recoveryOwners = [
  'policy transaction', 'Realm management read', 'Realm management write',
  'Realm roster', 'Realm placement permit', 'Realm policy recovery', 'Work edit authority',
  'Agent owner authority', 'Realm owner authority', 'command owner authority',
  'Governance decision head', 'Governance graph effect', 'publication fence',
  'PublicReports anonymous', 'PublicReports signed', 'recommendation eligibility',
] as const;
type RecoveryOwner = typeof recoveryOwners[number];
type RecoveryFixture = {
  run: (callback: () => Promise<void>) => Promise<unknown>;
  unavailable: typeof ControlUnavailable;
};

/** Exercise real public owners; only external graph responses are deterministic.
 * Each owner gets its usual authority and its usual callback boundary. */
async function recoveryOwner(owner: RecoveryOwner, graph: ReturnType<typeof indexedGraph>): Promise<RecoveryFixture> {
  const f = await identity();
  await ensureFixtureScopeGate(pool, `governance:realm:${f.realm}`);
  if (owner === 'policy transaction') return {
    unavailable: PolicyUnavailable,
    run: callback => inAccessTransaction(pool, 'read committed', async client => {
      await requireRecoveryOpen(client, true);
      return callback();
    }),
  };
  if (owner === 'Realm management read' || owner === 'Realm management write') return {
    unavailable: RealmAdminUnavailable,
    run: callback => realmTransaction(pool, f.realm, owner === 'Realm management write', callback),
  };
  if (owner === 'Realm roster') {
    let callback: () => Promise<void>;
    let called = false;
    const policyGraph = { query: async () => {
      if (!called) { called = true; await callback(); }
      return { results: { bindings: [{ space: { type: 'uri', value: f.work },
        disclosure: { type: 'uri', value: 'https://rezics.com/vocab/Public' } }] } };
    } } as unknown as FusekiClient;
    const roster = new AccessRealmRoster(pool, { ...graph.env, fuseki: policyGraph });
    return { unavailable: RealmAdminUnavailable, run: work => { callback = work; return roster.read(f.realm, {}); } };
  }
  if (owner === 'Realm placement permit') {
    await f.grant('realm.owner', `governance:realm:${f.realm}`);
    return { unavailable: AdmissionUnavailable,
      run: callback => f.access.withRealmPolicy(f.principal, f.actor, f.realm, 'reply', callback) };
  }
  if (owner === 'Work edit authority') {
    await f.grant('work.edit', `work:edit:${f.work}`);
    return { unavailable: AdmissionUnavailable,
      run: callback => f.access.withWorkEditAuthority(f.principal, f.actor, f.work, callback) };
  }
  if (owner === 'Agent owner authority' || owner === 'Realm owner authority' || owner === 'command owner authority') {
    const action = owner === 'Agent owner authority' ? 'agent.control'
      : owner === 'Realm owner authority' ? 'realm.settings.manage' : 'work.create';
    const scope = owner === 'Agent owner authority' ? `agent:control:${f.actor}`
      : owner === 'Realm owner authority' ? `governance:realm:${f.realm}` : 'work:create:root';
    await f.grant(action, scope);
    return { unavailable: AdmissionUnavailable, run: callback => f.access.withOwnerAuthority({
      principal: f.principal, actingSubject: f.actor, action, scope,
    }, callback) };
  }
  if (owner === 'publication fence') return { unavailable: GovernanceUnavailable,
    run: callback => publicationStore().withPublicationFence([f.work], async allowed => {
      expect(allowed).toBe(true); await callback();
    }) };
  if (owner === 'recommendation eligibility') {
    await f.grant('publication.adopt', `publication:adopt:${f.realm}`);
    const store = new RealmVariantRecommendationStore(pool);
    return { unavailable: AdmissionUnavailable, run: callback => store.set(f.principal, {
      realm: f.realm, mainVersion: native(), contribution: native(), expectedRevision: null,
      actingSubject: f.actor, idempotencyKey: randomUUID(),
    }, async () => { await callback(); return true; }) };
  }
  if (owner === 'PublicReports signed' || owner === 'PublicReports anonymous') {
    const signed = owner === 'PublicReports signed';
    const revision = randomUUID();
    let callback: () => Promise<void>;
    const reports = new PublicReports(pool, { resolve: async () => {
      // The first lookup precedes intake; the preservation re-admission is the
      // callback whose disclosure/index accesses must use the fenced holding.
      if (accessClient(pool)) await callback();
      return { evidence: { owner: 'content', resource: f.work, component: 'body', locator: null,
        revision, state: 'available', representation: 'content-body-v1',
        revisionDigest: 'b'.repeat(64), provenance: {} }, author: f.actor, realm: null };
    } });
    return { unavailable: GovernanceUnavailable, run: work => {
      callback = work;
      return reports.submit({ profile: 'public-report-v1', category: 'child_exploitation', target: f.work,
        statement: 'Preserve reported material.', contentLanguage: 'en' }, randomUUID(),
      new Request('http://main.test/v1/public-reports'), signed ? f.principal : null);
    } };
  }
  if (owner === 'Realm policy recovery') {
    const receipt = randomUUID();
    await controlTransaction(pool, async client => {
      await client.query(`INSERT INTO access.realm_admin_receipt
        (id,realm,principal_id,acting_subject,idempotency_key,request_digest,action,reason,result)
        VALUES ($1,$2,$3,$4,$5,$6,'realm.settings','Publish policy','{}')`,
      [receipt, f.realm, f.principalId, f.actor, randomUUID(), 'a'.repeat(64)]);
      await client.query(`INSERT INTO access.realm_policy_delivery(realm,receipt_id,generation,visibility,review_mode)
        VALUES ($1,$2,1,'public','open')`, [f.realm, receipt]);
    });
    let callback: () => Promise<void>;
    let published = false;
    graph.graph.query = async query => query.includes('ASK') ? { boolean: published }
      : { results: { bindings: [{ space: { type: 'uri', value: f.work } }] } };
    const command = graph.graph.command.bind(graph.graph);
    graph.graph.command = async envelope => {
      await callback();
      const result = await command(envelope);
      published = true;
      return result;
    };
    return { unavailable: RealmAdminUnavailable,
      run: work => { callback = work; return settleRealmPolicy(pool, f.realm, graph.env); } };
  }
  // Governance decisions probe exact heads before planning and dispatch graph
  // effects under separate owner transactions. Both are raw callback owners.
  await f.grant('governance.moderate', 'governance:platform');
  const revision = native();
  const target = { owner: 'graph' as const, resource: f.work, component: 'title' as const, revision, locator: null };
  const rule = { ref: 'urn:rule:recovery-owner', revision: '1', digest: 'a'.repeat(64) };
  let callback: (() => Promise<void>) | undefined;
  const store = new GovernanceStore(pool, { capture: async (_principal, _actor, evidence) => ({ ...evidence,
    state: 'available', representation: 'Retained evidence', revisionDigest: 'b'.repeat(64), provenance: {} }) },
  { current: async () => {
    if (owner === 'Governance decision head' && callback && accessClient(pool)) {
      const work = callback; callback = undefined; await work();
    }
    return revision;
  } }, { current: async () => rule }, { participants: async () => [], apply: async () => {
    if (owner === 'Governance graph effect' && callback) { const work = callback; callback = undefined; await work(); }
    return { receipt: await graph.command() };
  } });
  const report = await store.submitReport(f.principal, { kind: 'content_report', actingSubject: f.actor,
    authority: { kind: 'platform', scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
    target, disclosure: 'private', reasonCode: 'spam', statement: 'Review exact material.', evidence: [target],
    idempotencyKey: randomUUID() });
  await store.safety.claim(f.principal, f.actor, report.caseId);
  const input: DecisionInput = { caseId: report.caseId, expectedGeneration: report.caseGeneration,
    actingSubject: f.actor, outcome: 'restrict', targets: [{ ...target, scopeKind: 'exact_revision',
      expectedHead: revision, effect: 'disclosure' }], rule, evidenceDigest: report.evidenceDigest,
    reversesDecisionId: null, answersStepId: null, rationale: null, disclosure: 'private', idempotencyKey: randomUUID(),
    reasons: { facts: 'Staff reviewed exact evidence.', scope: 'One retained revision.', duration: 'Until reconsidered.',
      automation: false, contentLanguage: 'en', appealRoute: '/v1/public-reports/{caseId}/correspondence' } };
  return { unavailable: GovernanceUnavailable, run: work => { callback = work; return store.decide(f.principal, input); } };
}

async function recoveryDomainRows() {
  return (await pool.query(`SELECT
    (SELECT count(*) FROM access.governance_report)::text AS reports,
    (SELECT count(*) FROM access.moderation_decision)::text AS decisions,
    (SELECT count(*) FROM access.governance_erasure_postponement)::text AS postponements,
    (SELECT count(*) FROM access.realm_native_variant_recommendation_receipt)::text AS recommendations,
    (SELECT count(*) FROM access.realm_policy_delivery WHERE delivered)::text AS deliveries,
    (SELECT count(*) FROM access.template_seek_pending)::text AS pending`)).rows[0];
}

for (const owner of recoveryOwners) {
  for (const recovery of ['closed', 'closing during callback', 'open'] as const) {
    test(`${owner}: recovery ${recovery} gates callback disclosure/index and retains one checkout through commit`, async () => {
      const graph = indexedGraph();
      // A separate pool is the recovery owner, never a nested checkout of the
      // application's max:1 pool. Both pools deliberately have only one client.
      const closer = new Pool({ ...cluster!.connection, max: 1, connectionTimeoutMillis: 1_000 });
      let closing: Promise<unknown> | undefined;
      try {
        const fixture = await recoveryOwner(owner, graph);
        const before = await recoveryDomainRows();
        const marker = randomUUID();
        let callbacks = 0, closeFinished = false;
        if (recovery === 'closed') await closer.query('UPDATE access.recovery_fence SET open=false WHERE id');
        const run = fixture.run(async () => {
          callbacks++;
          const { client, id } = await heldTransaction();
          if (recovery === 'closing during callback') {
            const recoveryClient = await closer.connect();
            const closerPid = (await recoveryClient.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            const ownerPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
            closing = recoveryClient.query('UPDATE access.recovery_fence SET open=false WHERE id')
              .then(() => { closeFinished = true; }).finally(() => recoveryClient.release());
            let blocked = false;
            const deadline = Date.now() + 1_000;
            while (!blocked && Date.now() < deadline) {
              blocked = (await client.query<{ blocked: boolean }>('SELECT $2::int = ANY(pg_blocking_pids($1)) AS blocked',
                [closerPid, ownerPid])).rows[0]!.blocked;
              if (!blocked) await Bun.sleep(5);
            }
            expect(blocked).toBe(true);
            expect(closeFinished).toBe(false);
          }
          const reader = new DisclosureStore(pool);
          expect(await reader.read(await establishedTargets([{ owner: 'content', resource: native(), component: 'body' }]),
            ANONYMOUS_VIEWER, 'thread')).toEqual(['visible']);
          // The Realm delivery wrapper itself is graph.command: invoking the
          // fixture command there would recurse into that wrapper. Use its
          // genuinely attached index directly for this variant's callback.
          if (owner === 'Realm policy recovery') await graph.index.apply({
            position: { dataEpoch: graph.epoch, sequence: '1' }, bases: [], entities: [],
          });
          else await graph.command();
          await client.query('INSERT INTO access.template_seek_pending(epoch,sequence,id,delta) VALUES ($1,1,$2,$3)',
            [marker, 'owner-commit', { bases: [] }]);
          await sameTransaction(client, id);
          if (recovery === 'closing during callback') expect(closeFinished).toBe(false);
        });
        if (recovery === 'closed') {
          await expect(run).rejects.toBeInstanceOf(fixture.unavailable);
          expect(callbacks).toBe(0);
          expect(graph.envelopes).toHaveLength(0);
          expect(await recoveryDomainRows()).toEqual(before);
        } else {
          // Governance may need another fenced owner transaction after the
          // callback commits. A close winning that later boundary must refuse.
          try { await run; } catch (error) {
            if (recovery !== 'closing during callback' || !owner.startsWith('Governance ')) throw error;
            expect(error).toBeInstanceOf(GovernanceUnavailable);
          }
          expect(callbacks).toBe(1);
          await closing;
          expect((await pool.query('SELECT 1 FROM access.template_seek_pending WHERE epoch=$1', [marker])).rowCount).toBe(1);
          expect((await pool.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0]!.open)
            .toBe(recovery === 'open');
          expect(graph.envelopes.length).toBeGreaterThan(0);
        }
        expect(accessClient(pool)).toBeUndefined();
      } finally {
        await closing;
        await closer.query('UPDATE access.recovery_fence SET open=true WHERE id');
        await closer.end();
        await graph.stop();
      }
    }, 30_000);
  }
}
