import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import type { AdmissionRequest, VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';

const replyRoot = await import('../src/modules/realm-reply/root.ts');
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

const { AccessAdmissionRegistry, AdmissionConflict, AdmissionUnavailable } =
  await import('../src/modules/access/admission.ts');
const replyContentStore = await import('../src/modules/realm-reply/content-store.ts');
const realmReplyStore = await import('../src/modules/realm-reply/store.ts');
const spacePolicy = await import('../src/modules/space/policy.ts');
const { WorkReadMoved, WorkReadUnavailable } = await import('../src/modules/work/read-session.ts');
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
    await expect(author.access.register({ ...input, baselineRelatedWork: nativeId() }))
      .rejects.toBeInstanceOf(AdmissionConflict);
    expect(calls).toHaveLength(2);
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
    expect(calls).toHaveLength(4);
    for (const [index, call] of calls.entries()) {
      expect(call).toMatchObject({ resource: rootTarget, revision: rootRevision, actor: author.actingSubject });
      expect(call.principal).toBe(index < 2 ? supplied : current);
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
