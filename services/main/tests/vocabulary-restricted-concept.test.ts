import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { ContentModeration } from '../../content/src/moderation.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { AgentProvisioning, agentProvisionDigest } from '../src/modules/agent/provision.ts';
import { configureDisclosure, DisclosureUnavailable, DISCLOSURE_COST } from '../src/modules/disclosure/read.ts';
import { ownerModerationEffects } from '../src/modules/governance/effects.ts';
import { GLOBAL_CONTEXT, GovernanceStore, type DecisionInput } from '../src/modules/governance/store.ts';
import { readRealmDirectory } from '../src/modules/realm-directory/read.ts';
import { readSharedVocabulary } from '../src/modules/realm-directory/vocabulary.ts';
import { type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadInvalid, WorkReadMoved, WorkReadUnavailable, WorkReadSession, type ReadRow } from '../src/modules/work/read-session.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const position = { dataEpoch: 'vocabulary-owner-epoch', sequence: '1' };
const binding = (value: string) => ({ type: 'uri', value });
const rule = { ref: 'urn:rezics:rule:vocabulary-fixture', revision: '1', digest: 'a'.repeat(64) };
const principal: VerifiedPrincipal = { issuer: 'https://account.vocabulary.test', subject: randomUUID() };
let cluster: PostgresCluster | undefined;
let pool: Pool;
let actor: string;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4 });
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

  // The graph owner returns a bounded, retained creation receipt. Access still
  // runs its real product provisioning transitions and checks that principal.
  const input = { kind: 'person' as const, displayName: 'Vocabulary moderator' };
  const env = { fuseki: { query: async () => ({ results: { bindings: [{
    digest: { type: 'literal', value: agentProvisionDigest(input) },
    epoch: { type: 'literal', value: position.dataEpoch },
    sequence: { type: 'literal', value: position.sequence },
  }] } }) }, lineage: { ...position, routingEpoch: 'routing' },
  objectDirectory: join(root, '.temp/vocabulary-owner') } as unknown as WorkActivationEnvironment;
  const provision = await new AgentProvisioning(pool, env).provision(
    { verify: async () => principal }, new Request('http://main.test/v1/agents'), input, randomUUID());
  expect(provision.state).toBe('active');
  actor = provision.agent;
  const principalId = (await pool.query<{ id: string }>(
    'SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2',
    [principal.issuer, principal.subject])).rows[0]!.id;
  await grantFixtureAuthority(pool, { scope: 'governance:platform', requireDispatch: true,
    representations: [{ principalId, actor, action: 'governance.moderate', lifetime: 'infinity' }],
    grant: { actor, action: 'governance.moderate', lifetime: 'infinity' } });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

interface Concept { id: string; head: string; label: string }
const concept = (label: string): Concept => ({ id: native(), head: native(), label });

function fixture(concepts: Concept[]) {
  // Only the graph projection is substituted. Restrictions below are committed
  // by GovernanceStore and classified by the real PostgreSQL disclosure owner.
  const graph = { query: async (query: string) => {
    let rows: ReadRow[] = [];
    if (query.includes('SELECT DISTINCT ?kind ?head')) return { results: { bindings: [{ kind: binding('http://www.w3.org/2004/02/skos/core#Concept') }] } };
    if (query.includes('SELECT ?work ?head')) {
      rows = concepts.filter(value => query.includes(`<${value.id}>`))
        .map(value => ({ work: binding(value.id), head: binding(value.head) }));
    } else if (query.includes('skos:prefLabel')) {
      expect(query).toMatch(/SELECT[^{}]*\?head/);
      expect(query).toContain('COALESCE(?conceptHead, ?senseHead) AS ?head');
      const exact = concepts.filter(value => query.includes(`<${value.id}>`));
      const selected = /<https:\/\/rezics\.com\/id\/[0-9a-f-]{36}>/.test(query)
        || query.includes('VALUES') ? exact : concepts;
      rows = selected.map(value => ({ concept: binding(value.id), head: binding(value.head),
        label: { type: 'literal', value: value.label, 'xml:lang': 'en' } }));
    } else if (query.includes('rv:head')) {
      rows = concepts.filter(value => query.includes(`<${value.id}>`))
        .map(value => ({ concept: binding(value.id), head: binding(value.head) }));
    }
    return { results: { bindings: rows } };
  } };
  const environment = { fuseki: graph, lineage: { dataEpoch: position.dataEpoch, routingEpoch: 'routing' },
    objectDirectory: join(root, '.temp/vocabulary-owner') } as unknown as WorkActivationEnvironment;
  const governance = new GovernanceStore(pool,
    { capture: async (_principal, _actor, target) => ({ ...target, state: 'available',
      representation: concepts.find(value => value.id === target.resource)?.label ?? 'Concept',
      revisionDigest: 'b'.repeat(64), provenance: {} }) },
    { current: async target => concepts.find(value => value.id === target.resource)?.head ?? null, realmBasis: async () => null },
    { current: async () => rule },
    ownerModerationEffects({} as ContentModeration, environment));
  configureDisclosure(environment, governance.disclosure);
  const freshSession = () => new WorkReadSession({ environment,
    access: { realmDirectory: { page: async () => ({ rows: [], position, sourcePosition: position,
      next: null }), fence: async () => {} } } } as unknown as MainWorkDependencies,
  new Request('http://main.test/v1/shared-vocabulary', { headers: { 'accept-language': 'en' } }),
  { limit: 20, publicViewer: ANONYMOUS_VIEWER }, position);

  let session = freshSession();

  async function restrict(value: Concept, component: 'record' | 'name' = 'record') {
    const target = { owner: 'graph' as const, resource: value.id, component,
      revision: value.head, locator: null };
    const report = await governance.submitReport(principal, { kind: 'content_report', actingSubject: actor,
      authority: { kind: 'platform', scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
      target, disclosure: 'private', reasonCode: 'spam', statement: 'Restrict this shared Concept from discovery.',
      evidence: [target], idempotencyKey: randomUUID() });
    await governance.safety.claim(principal, actor, report.caseId);
    const input: DecisionInput = { caseId: report.caseId, expectedGeneration: report.caseGeneration,
      actingSubject: actor, outcome: 'restrict',
      targets: [{ ...target, scopeKind: 'exact_revision', expectedHead: value.head, effect: 'search' }],
      rule, evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
      rationale: null, disclosure: 'private', idempotencyKey: randomUUID(),
      reasons: { facts: 'The current shared Concept label was reviewed.', scope: 'This Concept record in discovery.',
        duration: 'Until reconsidered.', automation: false, contentLanguage: 'en',
        appealRoute: '/v1/public-reports/{caseId}/correspondence' } };
    const decision = await governance.decide(principal, input);
    expect(decision.operation.status).toBe('completed');
    const rows = (await pool.query<{ effect: string; component: string; state: string }>(
      'SELECT effect,component,state FROM access.governance_enforcement WHERE decision_id = $1',
      [decision.decisionId])).rows;
    expect(rows).toEqual([{ effect: 'search', component, state: 'restricted' }]);
    // Establish that the real owner sees the committed fence before testing the
    // public adapters, so an adapter red cannot be blamed on fixture admission.
    expect(await governance.disclosure.read([target], ANONYMOUS_VIEWER, 'search')).toEqual(['hidden']);
    session = freshSession();
    return decision;
  }
  return { get session() { return session; }, restrict, reader: governance.disclosure };
}

test('restricted-concept-unique-label: anonymous vocabulary search omits a committed graph record search fence', async () => {
  const hidden = concept('Unique restricted vocabulary label');
  const visible = concept('Ordinary vocabulary label');
  const f = fixture([hidden, visible]);
  await f.restrict(hidden);
  expect(await readSharedVocabulary(f.session, hidden.label)).toEqual({
    profile: 'shared-vocabulary-v1', items: [], hasMore: false });
});

test('restricted-concept-full-vocabulary: removal precedes sorting, selection and disclosed hasMore', async () => {
  const hidden = concept('A restricted first label');
  const visible = Array.from({ length: 20 }, (_, index) => concept(`Visible label ${String(index).padStart(2, '0')}`));
  const f = fixture([hidden, ...visible]);
  await f.restrict(hidden);
  const result = await readSharedVocabulary(f.session);
  expect(result.items).toEqual(visible.map(value => ({ id: value.id, label: value.label })));
  expect(result.hasMore).toBe(false);
});

async function topicFailure(session: WorkReadSession, topic: string) {
  try { return { result: await readRealmDirectory(session, { sort: 'newest', topic }) }; }
  catch (error) {
    if (!(error instanceof WorkReadInvalid)) throw error;
    return { error: error.constructor.name, message: error.message };
  }
}

test('restricted-concept-realm-topic: the public topic response equals an unknown Concept without its label', async () => {
  const hidden = concept('Restricted Realm topic label');
  const f = fixture([hidden]);
  await f.restrict(hidden);
  const unknown = await topicFailure(f.session, native());
  expect(unknown).toEqual({ error: 'WorkReadInvalid', message: 'Topic is unavailable' });
  expect(await topicFailure(f.session, hidden.id)).toEqual(unknown);
});

test('unrestricted-concept-vocabulary-and-topic: ordinary Concept names remain discoverable anonymously', async () => {
  const visible = concept('Unrestricted vocabulary and Realm topic');
  const f = fixture([visible]);
  expect(await readSharedVocabulary(f.session, visible.label)).toEqual({
    profile: 'shared-vocabulary-v1', items: [{ id: visible.id, label: visible.label }], hasMore: false });
  const directory = await readRealmDirectory(f.session, { sort: 'newest', topic: visible.id });
  expect(directory.topic?.id).toBe(visible.id);
  expect(directory.topic?.label.value).toBe(visible.label);
});

test('restricted-concept-name: an exact name search fence hides both vocabulary and topic labels', async () => {
  const hidden = concept('Restricted Concept name component');
  const f = fixture([hidden]);
  await f.restrict(hidden, 'name');
  expect(await readSharedVocabulary(f.session, hidden.label)).toEqual({
    profile: 'shared-vocabulary-v1', items: [], hasMore: false });
  expect(await topicFailure(f.session, hidden.id)).toEqual({
    error: 'WorkReadInvalid', message: 'Topic is unavailable' });
});

for (const component of ['record', 'name'] as const) {
  test(`restricted-concept-${component}-revision: an old head restriction preserves the current labels in both resolvers`, async () => {
    const value = concept('Restricted old Concept label');
    const f = fixture([value]);
    await f.restrict(value, component);
    value.head = native();
    value.label = 'Current Concept label';

    const classify = f.session.disclosure.bind(f.session);
    f.session.disclosure = async (targets, ...args) => {
      for (const target of targets) expect(target.revision).toBe(value.head);
      return classify(targets, ...args);
    };
    expect(await readSharedVocabulary(f.session, value.label)).toEqual({
      profile: 'shared-vocabulary-v1', items: [{ id: value.id, label: value.label }], hasMore: false });
    const directory = await readRealmDirectory(f.session, { sort: 'newest', topic: value.id });
    expect(directory.topic?.id).toBe(value.id);
    expect(directory.topic?.label.value).toBe(value.label);

    await f.restrict(value, component);
    expect(await readSharedVocabulary(f.session, value.label)).toEqual({
      profile: 'shared-vocabulary-v1', items: [], hasMore: false });
    expect(await topicFailure(f.session, value.id)).toEqual({
      error: 'WorkReadInvalid', message: 'Topic is unavailable' });
  });
}

test('restricted-concept-selected-revision: a new head cannot release the restricted name selected by either resolver', async () => {
  for (const resolver of ['vocabulary', 'topic'] as const) {
    const value = concept('Restricted selected Concept name');
    const f = fixture([value]);
    await f.restrict(value, 'name');
    const selectedRevision = value.head;
    const query = f.session.query.bind(f.session);
    f.session.query = async (...args) => {
      const rows = await query(...args);
      if (args[0].includes('skos:prefLabel')) {
        value.head = native();
        value.label = 'New unrestricted Concept name';
      }
      return rows;
    };
    const classify = f.session.disclosure.bind(f.session);
    f.session.disclosure = async (targets, ...args) => {
      for (const target of targets) expect(target.revision).toBe(selectedRevision);
      return classify(targets, ...args);
    };
    if (resolver === 'vocabulary') expect((await readSharedVocabulary(f.session)).items).toEqual([]);
    else expect(await topicFailure(f.session, value.id)).toEqual({
      error: 'WorkReadInvalid', message: 'Topic is unavailable' });
    expect(value.head).not.toBe(selectedRevision);
  }
});

test('concept-disclosure-invalid-revision: missing or conflicting label heads fail closed in both resolvers', async () => {
  for (const invalid of ['missing', 'conflicting'] as const) {
    const value = concept('Concept with invalid label revision');
    const f = fixture([value]);
    const query = f.session.query.bind(f.session);
    f.session.query = async (...args) => {
      const rows = await query(...args);
      if (!args[0].includes('skos:prefLabel')) return rows;
      return invalid === 'missing' ? rows.map(row => {
        const withoutHead = { ...row };
        delete withoutHead.head;
        return withoutHead;
      })
        : [...rows, { ...rows[0]!, head: binding(native()) }];
    };
    await expect(readSharedVocabulary(f.session)).rejects.toBeInstanceOf(WorkReadUnavailable);
    await expect(readRealmDirectory(f.session, { sort: 'newest', topic: value.id })).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
});

test('restricted-concept-vocabulary-final-fence: a committed restriction after opening classification withholds the label', async () => {
  const hidden = concept('Vocabulary restriction during read');
  const f = fixture([hidden]);
  const classify = f.session.disclosure.bind(f.session);
  let installed = false;
  f.session.disclosure = async (...args) => {
    const decisions = await classify(...args);
    if (!installed) { installed = true; await f.restrict(hidden); }
    return decisions;
  };
  await expect(readSharedVocabulary(f.session, hidden.label)).rejects.toBeInstanceOf(WorkReadMoved);
  expect(installed).toBe(true);
  expect((await readSharedVocabulary(f.session, hidden.label)).items).toEqual([]);
});

test('restricted-concept-topic-final-fence: a committed restriction after opening classification withholds the topic label', async () => {
  const hidden = concept('Realm topic restriction during read');
  const f = fixture([hidden]);
  const classify = f.session.disclosure.bind(f.session);
  let installed = false;
  f.session.disclosure = async (...args) => {
    const decisions = await classify(...args);
    if (!installed) { installed = true; await f.restrict(hidden); }
    return decisions;
  };
  await expect(topicFailure(f.session, hidden.id)).rejects.toBeInstanceOf(WorkReadMoved);
  expect(installed).toBe(true);
  expect(await topicFailure(f.session, hidden.id)).toEqual({ error: 'WorkReadInvalid', message: 'Topic is unavailable' });
});

test('concept-disclosure-missing-owner: neither public resolver may turn an absent owner into visible labels', async () => {
  const visible = concept('Concept without disclosure owner');
  const f = fixture([visible]);
  configureDisclosure(f.session.deps.environment, null);
  await expect(readSharedVocabulary(f.session)).rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(readRealmDirectory(f.session, { sort: 'newest', topic: visible.id })).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('concept-disclosure-incomplete-owner: failed or truncated classifications cannot disclose either resolver', async () => {
  const visible = concept('Concept with incomplete disclosure');
  const f = fixture([visible]);
  for (const read of [async () => [] as never[], async (): Promise<never[]> => { throw new DisclosureUnavailable('Owner unavailable'); }]) {
    configureDisclosure(f.session.deps.environment, { read });
    await expect(readSharedVocabulary(f.session)).rejects.toBeInstanceOf(WorkReadUnavailable);
    await expect(readRealmDirectory(f.session, { sort: 'newest', topic: visible.id })).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
});

test('concept-disclosure-bounded-inventory: both current policy passes keep transport batches at 64', async () => {
  const visible = Array.from({ length: 256 }, (_, index) => concept(`Vocabulary ${index}`));
  const f = fixture(visible);
  const sizes: number[] = [];
  configureDisclosure(f.session.deps.environment, { read: async (...args) => {
    sizes.push(args[0].length); return f.reader.read(...args);
  } });
  const page = await readSharedVocabulary(f.session);
  expect(page.items).toHaveLength(20);
  expect(page.hasMore).toBe(true);
  expect(sizes).toEqual(Array.from({ length: 16 }, () => DISCLOSURE_COST.batch));
});
