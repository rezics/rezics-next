import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import type { AdmissionRequest, VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';

const replyRoot = await import('../src/modules/realm-reply/root.ts');
// A unique module specifier keeps another test file's module mock from
// replacing this integration's real root reader.
const actualReadableReplyRoot = (await import(
  `${import.meta.dir}/../src/modules/realm-reply/root.ts?live-root`)).readableReplyRoot;
type ReadableReplyRootArgs = Parameters<typeof replyRoot.readableReplyRoot>;
let rootDecision: (...args: ReadableReplyRootArgs) => Promise<boolean> = async () => true;
let publicRootDecision: (...args: Parameters<typeof replyRoot.publicReplyRoot>) => Promise<boolean> =
  (...args) => replyRoot.publicReplyRoot(...args);
const disclosure = await import('../src/modules/disclosure/read.ts');
const visibleSemanticQueries: string[] = [];
let visibleSemanticResource: string | null = null;
const graph = { query: async (query: string) => {
  visibleSemanticQueries.push(query);
  if (query.includes('SELECT ?resource WHERE') && visibleSemanticResource
    && query.includes(`<${visibleSemanticResource}>`)) {
    return { results: { bindings: [{ resource: { type: 'uri', value: visibleSemanticResource } }] } };
  }
  return { results: { bindings: [] } };
} };
const environment = { fuseki: graph,
  lineage: { dataEpoch: 'reply-root-test', routingEpoch: 'reply-root-routing' } } as unknown as WorkActivationEnvironment;
disclosure.configureDisclosure(environment, null);

await mock.module('../src/modules/realm-reply/root.ts', () => ({
  ...replyRoot,
  readableReplyRoot: (...args: ReadableReplyRootArgs) => rootDecision(...args),
  publicReplyRoot: (...args: Parameters<typeof replyRoot.publicReplyRoot>) => publicRootDecision(...args),
}));

const { AccessAdmissionRegistry, AdmissionConflict, AdmissionDenied, AdmissionUnavailable } =
  await import('../src/modules/access/admission.ts');
const replyContentStore = await import('../src/modules/realm-reply/content-store.ts');
const realmReplyStore = await import('../src/modules/realm-reply/store.ts');
const spacePolicy = await import('../src/modules/space/policy.ts');
const { WorkReadMoved, WorkReadUnavailable } = await import('../src/modules/work/read-session.ts');
const { prepareComponent } = await import('../src/modules/work/activate.ts');
const { PROFILES } = await import('../src/modules/semantic/schema.ts');
const root = resolve(import.meta.dir, '../../..');
const nativeId = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const staleEvidence = { age: '15-17' as const, country: 'AA', accountEligible: true, adultAvailable: false,
  categories: { general: true, r15: true, r18: false, r18g: false } };
const currentEvidence = { age: 'adult' as const, country: 'BB', accountEligible: true, adultAvailable: true,
  categories: { general: true, r15: true, r18: true, r18g: false } };
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
  } finally {
    client.release();
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
  await mock.module('../src/modules/realm-reply/root.ts', () => replyRoot);
  await mock.module('../src/modules/realm-reply/content-store.ts', () => replyContentStore);
  await mock.module('../src/modules/realm-reply/store.ts', () => realmReplyStore);
  await mock.module('../src/modules/space/policy.ts', () => spacePolicy);
});

function principal(): { supplied: VerifiedPrincipal; current: VerifiedPrincipal } {
  const identity = { issuer: 'https://account.reply-roots.test', subject: randomUUID(), emailVerified: true };
  const current: VerifiedPrincipal = { ...identity, contentEvidence: currentEvidence };
  const supplied: VerifiedPrincipal = { ...identity, contentEvidence: staleEvidence,
    currentAssertion: async () => current };
  current.currentAssertion = async () => current;
  return { supplied, current };
}

async function person(identity: VerifiedPrincipal) {
  const found = await pool.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2`, [identity.issuer, identity.subject]);
  const principalId = found.rows[0]?.id ?? (await pool.query<{ id: string }>(`INSERT INTO access.principal
    (id, account_issuer, account_subject) VALUES ($1,$2,$3) RETURNING id`,
  [randomUUID(), identity.issuer, identity.subject])).rows[0]!.id;
  const actingSubject = nativeId();
  const representationId = randomUUID();
  const provisionId = randomUUID();
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actingSubject]);
  await pool.query(`INSERT INTO access.representation
    (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [representationId, principalId, actingSubject]);
  await pool.query(`INSERT INTO access.agent_provision
    (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind, display_name,
     principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
    VALUES ($1,$2,$3,$4,$5,'person','Reply author',0,'active','reply-root-test',1,$6)`,
  [provisionId, principalId, `reply-roots-${randomUUID()}`, digest(randomUUID()), actingSubject, representationId]);
  const access = new AccessAdmissionRegistry(pool);
  access.configureBaseline(graph as never);
  return { access, principalId, actingSubject, provisionId };
}

async function seedRealm(actor: string, principalId: string) {
  const realm = nativeId();
  const membershipId = randomUUID();
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [realm]);
  await pool.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1)', [realm]);
  await pool.query(`INSERT INTO access.realm_admin_settings (realm, who_may_submit)
    VALUES ($1,'granted')`, [realm]);
  await pool.query(`INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [`governance:realm:${realm}`]);
  await pool.query(`INSERT INTO access.membership_policy
    (kind, owner_subject, revision, terms_revision) VALUES ('realm',$1,0,'terms-v1')`, [realm]);
  await pool.query(`INSERT INTO access.membership
    (id, kind, owner_subject, member_subject, state, generation, policy_revision, terms_revision, consent_reference)
    VALUES ($1,'realm',$2,$3,'joined',1,0,'terms-v1','reply-root-test')`, [membershipId, realm, actor]);
  return realm;
}

function replyDraft(identity: VerifiedPrincipal, actor: string, rootTarget: string,
  rootRevision: string): AdmissionRequest {
  const key = `reply-root-${randomUUID()}`;
  return { principal: identity, actingSubject: actor, action: 'content.draft',
    scope: `content:draft:${nativeId()}`, baselineRelatedWork: rootTarget,
    baselineSourceRevision: rootRevision, idempotencyKey: key, requestDigest: digest(key) };
}

test('reply root registration, replay, claim and fence use exact saved root, Person and held client', async () => {
  const { supplied, current } = principal();
  const author = await person(supplied);
  const realm = await seedRealm(author.actingSubject, author.principalId);
  const rootTarget = nativeId();
  const rootRevision = nativeId();
  const input = replyDraft(supplied, author.actingSubject, rootTarget, rootRevision);
  const calls: { resource: string; revision: string; principal: VerifiedPrincipal | null; actor?: string }[] = [];
  const checkouts = spyOn(pool, 'connect');
  const priorCheckoutCount = () => checkouts.mock.calls.length;
  rootDecision = async (env, resource, revision, readers, verifiedPrincipal, actor) => {
    expect(env).toBe(environment);
    calls.push({ resource, revision, principal: verifiedPrincipal ?? null, actor });
    if (!readers?.canReadSemanticResource || !readers.realmReadProof) return false;
    visibleSemanticResource = resource;
    const before = priorCheckoutCount();
    expect(await readers.canReadSemanticResource(verifiedPrincipal ?? null, actor!, resource, revision)).toBe(true);
    expect(visibleSemanticQueries.at(-1)).toContain(`FILTER(?head = <${revision}>)`);
    expect(await readers.realmReadProof(verifiedPrincipal!, actor!, realm)).toBeString();
    expect(priorCheckoutCount()).toBe(before);
    return true;
  };
  try {
    const registered = await author.access.register(input);
    expect(registered.dispatchEligible).toBe(true);
    expect((await pool.query(`SELECT related_work, source_revision FROM access.baseline_admission
      WHERE admission_id = $1`, [registered.id])).rows[0]).toEqual({
      related_work: rootTarget, source_revision: rootRevision,
    });
    expect(await author.access.register(input)).toMatchObject({ id: registered.id,
      dispatchEligible: true, replayed: true });
    // Replay checks current authority and the saved root separately. A changed
    // intent also checks current authority before disclosing the conflict.
    expect(calls).toHaveLength(3);
    const changedRoot = nativeId();
    await expect(author.access.register({ ...input, baselineRelatedWork: changedRoot }))
      .rejects.toBeInstanceOf(AdmissionConflict);
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)).toEqual({ resource: changedRoot, revision: rootRevision,
      actor: author.actingSubject, principal: supplied });
    expect(await author.access.claim(registered.id, input.requestDigest, supplied)).toMatchObject({
      id: registered.id, state: 'claimed',
    });
    const fence = await pool.connect();
    try {
      await fence.query('BEGIN');
      expect(await author.access.fenceClaim(fence, registered.id, input.requestDigest, supplied)).toMatchObject({
        id: registered.id, state: 'claimed',
      });
      await fence.query('COMMIT');
    } catch (error) {
      await fence.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { fence.release(); }
    expect(calls).toHaveLength(6);
    for (const [index, call] of calls.entries()) {
      expect(call).toMatchObject({ resource: index === 3 ? changedRoot : rootTarget,
        revision: rootRevision, actor: author.actingSubject });
      expect(call.principal).toBe(index < 4 ? supplied : current);
    }

    const replyRoot = nativeId();
    const replyRevision = nativeId();
    const replyKey = `reply-create-${randomUUID()}`;
    const created = await author.access.register({ principal: supplied, actingSubject: author.actingSubject,
      action: 'reply.create', scope: `reply:create:${replyRoot}`, baselineSourceRevision: replyRevision,
      idempotencyKey: replyKey, requestDigest: digest(replyKey) });
    expect(created.dispatchEligible).toBe(true);
    expect(calls.at(-1)).toMatchObject({ resource: replyRoot, revision: replyRevision,
      actor: author.actingSubject, principal: supplied });
  } finally {
    visibleSemanticResource = null;
    rootDecision = async () => true;
    checkouts.mockRestore();
  }
});

test('reply root environment and unavailable owners fail as unavailable; graph movement remains a refusal', async () => {
  const { supplied } = principal();
  const author = await person(supplied);
  const rootTarget = nativeId();
  const rootRevision = nativeId();

  const uncomposedGraph = { query: async () => ({ results: { bindings: [] } }) };
  const uncomposed = new AccessAdmissionRegistry(pool);
  uncomposed.configureBaseline(uncomposedGraph as never);
  await expect(uncomposed.register(replyDraft(supplied, author.actingSubject, rootTarget, rootRevision)))
    .rejects.toBeInstanceOf(AdmissionUnavailable);

  const savedDecision = rootDecision;
  try {
    rootDecision = async () => { throw new WorkReadUnavailable('Disclosure owner is unavailable'); };
    await expect(author.access.register(replyDraft(supplied, author.actingSubject, rootTarget, rootRevision)))
      .rejects.toBeInstanceOf(AdmissionUnavailable);
    rootDecision = async () => { throw new WorkReadMoved('Target graph moved'); };
    await expect(author.access.register(replyDraft(supplied, author.actingSubject, rootTarget, rootRevision)))
      .rejects.toBeInstanceOf(WorkReadMoved);
  } finally { rootDecision = savedDecision; }
});

test('unconfigured baseline keeps member reply register, replay and claim unavailable', async () => {
  const { supplied } = principal();
  const author = await person(supplied);
  const unconfigured = new AccessAdmissionRegistry(pool);
  const rootTarget = nativeId();
  const rootRevision = nativeId();
  const newIntent = replyDraft(supplied, author.actingSubject, rootTarget, rootRevision);

  await expect(unconfigured.register(newIntent)).rejects.toBeInstanceOf(AdmissionUnavailable);

  const savedIntent = replyDraft(supplied, author.actingSubject, nativeId(), nativeId());
  const registered = await author.access.register(savedIntent);
  await expect(unconfigured.register(savedIntent)).rejects.toBeInstanceOf(AdmissionUnavailable);
  await expect(unconfigured.claim(registered.id, savedIntent.requestDigest, supplied))
    .rejects.toBeInstanceOf(AdmissionUnavailable);
});

test('retained semantic reply roots use live disclosure through the held Access client', async () => {
  const { supplied } = principal();
  const author = await person(supplied);
  const resource = nativeId();
  const savedRoot = nativeId();
  const objectDirectory = mkdtempSync(join(root, '.temp', 'reply-root-semantic-'));
  const manifest = `urn:rezics:sha256:${prepareComponent(objectDirectory, resource,
    { component: 'resource', lifecycle: 'active', types: [], properties: [] }, PROFILES.resource)}`;
  let semanticHead = nativeId();
  let liveReadable = true;
  const semanticQueries: string[] = [];
  const retainedRootQueries: string[] = [];
  const resolvedHeads: string[] = [];
  const term = (value: string) => ({ type: 'uri', value });
  const literal = (value: string) => ({ type: 'literal', value });
  const graph = { query: async (query: string) => {
    if (query.includes('SELECT ?epoch ?sequence WHERE')) {
      return { results: { bindings: [{ epoch: literal('reply-root-test'), sequence: literal('1') }] } };
    }
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) {
      return { results: { bindings: [{ epoch: literal('reply-root-test'), sequence: literal('1'),
        r: term(resource), type: literal('resource'), public: literal('false') }] } };
    }
    if (query.includes('SELECT ?resource WHERE') && query.includes('rv:semanticHead')) {
      semanticQueries.push(query);
      return { results: { bindings: liveReadable ? [{ resource: term(resource) }] : [] } };
    }
    if (query.includes('SELECT ?resource ?manifest WHERE')) {
      return { results: { bindings: [{ resource: term(resource), manifest: term(manifest) }] } };
    }
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision ?type ?mergedInto')) {
      resolvedHeads.push(semanticHead);
      return { results: { bindings: [{ epoch: literal('reply-root-test'), sequence: literal('1'),
        r: term(resource), revision: term(semanticHead), type: term('https://rezics.com/vocab/Resource') }] } };
    }
    if (query.includes('SELECT ?root WHERE')) {
      retainedRootQueries.push(query);
      return { results: { bindings: [{ root: term(savedRoot) }] } };
    }
    return { results: { bindings: [] } };
  } };
  const localEnvironment = { fuseki: graph, objectDirectory,
    lineage: { dataEpoch: 'reply-root-test', routingEpoch: 'reply-root-routing' } } as unknown as WorkActivationEnvironment;
  const singleConnectionPool = new Pool({ ...cluster!.connection, max: 1, connectionTimeoutMillis: 1000 });
  const checkouts = spyOn(singleConnectionPool, 'connect');
  const access = new AccessAdmissionRegistry(singleConnectionPool);
  access.configureBaseline(graph as never);
  disclosure.configureDisclosure(localEnvironment, new disclosure.DisclosureStore(singleConnectionPool));
  const savedDecision = rootDecision;
  rootDecision = (...args) => actualReadableReplyRoot(...args);
  try {
    const original = replyDraft(supplied, author.actingSubject, resource, savedRoot);
    const concurrent = replyDraft(supplied, author.actingSubject, resource, savedRoot);
    const [registered, concurrentAdmission] = await Promise.all([
      access.register(original), access.register(concurrent),
    ]);
    expect(registered.dispatchEligible).toBe(true);
    expect(concurrentAdmission.dispatchEligible).toBe(true);
    // Both concurrent admissions complete with one checkout each. A nested
    // DisclosureStore pool query would wait on this size-one pool.
    expect(checkouts).toHaveBeenCalledTimes(2);
    expect(retainedRootQueries.length).toBeGreaterThan(0);
    expect(retainedRootQueries.every(query => query.includes(`<${savedRoot}>`))).toBe(true);

    semanticHead = nativeId();
    expect(semanticHead).not.toBe(savedRoot);
    expect(await access.register(original)).toMatchObject({ id: registered.id,
      dispatchEligible: true, replayed: true });
    expect(checkouts).toHaveBeenCalledTimes(3);
    expect(await access.claim(registered.id, original.requestDigest, supplied)).toMatchObject({
      id: registered.id, state: 'claimed',
    });
    expect(checkouts).toHaveBeenCalledTimes(4);
    expect(resolvedHeads).toContain(semanticHead);
    const fence = await singleConnectionPool.connect();
    expect(checkouts).toHaveBeenCalledTimes(5);
    try {
      await fence.query('BEGIN');
      expect(await access.fenceClaim(fence, registered.id, original.requestDigest, supplied))
        .toMatchObject({ id: registered.id, state: 'claimed' });
      expect(checkouts).toHaveBeenCalledTimes(5);
      await fence.query('COMMIT');
    } catch (error) {
      await fence.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { fence.release(); }

    const edit = replyDraft(supplied, author.actingSubject, resource, savedRoot);
    expect((await access.register(edit)).dispatchEligible).toBe(true);
    expect(checkouts).toHaveBeenCalledTimes(6);
    const revokedBeforeClaim = replyDraft(supplied, author.actingSubject, resource, savedRoot);
    const pending = await access.register(revokedBeforeClaim);
    expect(pending.dispatchEligible).toBe(true);
    expect(checkouts).toHaveBeenCalledTimes(7);

    liveReadable = false;
    await expect(access.claim(pending.id, revokedBeforeClaim.requestDigest, supplied))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect(checkouts).toHaveBeenCalledTimes(8);
    await expect(access.register(replyDraft(supplied, author.actingSubject, resource, savedRoot)))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect(checkouts).toHaveBeenCalledTimes(9);

    expect(semanticQueries.length).toBeGreaterThan(0);
    expect(semanticQueries.every(query => !query.includes(`FILTER(?head = <${savedRoot}>)`))).toBe(true);
  } finally {
    rootDecision = savedDecision;
    checkouts.mockRestore();
    disclosure.configureDisclosure(localEnvironment, null);
    rmSync(objectDirectory, { recursive: true, force: true });
    await singleConnectionPool.end();
  }
});

test('anonymous reply notifications consult only the public root decision', async () => {
  const reply = nativeId();
  const rootTarget = nativeId();
  const rootRevision = nativeId();
  const revisionId = randomUUID();
  const realm = nativeId();
  const publicRootCalls: Parameters<typeof replyRoot.publicReplyRoot>[] = [];
  await mock.module('../src/modules/realm-reply/content-store.ts', () => ({
    ...replyContentStore,
    RealmReplyContentStore: class {
      constructor(_pool: Pool) {}
      async readCurrent() { return { revisionId, body: 'A private reply', author: nativeId(), rootTarget, rootRevision }; }
      async readReply() { return { parentReply: null }; }
    },
  }));
  await mock.module('../src/modules/realm-reply/store.ts', () => ({
    ...realmReplyStore,
    visibleRealmReply: async () => ({ revisionId, placement: 'placement' }),
  }));
  await mock.module('../src/modules/space/policy.ts', () => ({
    ...spacePolicy,
    readRealmPolicy: async () => ({ visibility: 'public', reviewMode: 'open', revision: null,
      listing: 'listed', history: 'everything', admission: 'open', space: nativeId(), realmRevision: null }),
  }));
  publicRootDecision = async (...args) => { publicRootCalls.push(args); return false; };
  try {
    const { notificationProducerSubjectReader } =
      await import('../src/modules/notification-producers/subjects.ts');
    const reader = notificationProducerSubjectReader({} as Pool, {} as Pool, environment);
    const result = await reader.resolve({ owner: 'graph', ref: reply,
      revision: `urn:rezics:content:revision:${revisionId}`, principalId: randomUUID(),
      disclosureBasis: 'realm-reply-v1', realm });
    expect(result).toEqual({ status: 'undisclosed' });
    expect(publicRootCalls).toEqual([[graph, rootTarget, rootRevision]]);
  } finally {
    publicRootDecision = (...args) => replyRoot.publicReplyRoot(...args);
    await mock.module('../src/modules/realm-reply/content-store.ts', () => replyContentStore);
    await mock.module('../src/modules/realm-reply/store.ts', () => realmReplyStore);
    await mock.module('../src/modules/space/policy.ts', () => spacePolicy);
  }
});
