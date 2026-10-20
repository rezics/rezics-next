import { expect, test } from 'bun:test';
import type { Static } from 'typebox';
import { createMainApp } from '../src/app.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { FusekiClient, FusekiReadBudgetExceeded, fusekiReadBudget,
  type SparqlResult, type TemplateQueryEnvelope } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { template } from '../src/modules/query/templates/work-credits.schema.ts';
import { creditSeekKey } from '../src/modules/query/seek-index.ts';
import { RV } from '../src/modules/work/activate.ts';
import type { NativeCreditRole } from '../src/modules/work/read-contract.ts';
import type { ReadRow } from '../src/modules/work/read-session.ts';

interface NativeCredit { id: string; agent: string; role: NativeCreditRole; name: string }
const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const work = 'https://rezics.com/id/01a15329-a5c8-760d-b1d5-22382dba559b';
const author = { id: 'https://rezics.com/id/d4f350fd-ef71-479f-ad93-447b90541eb2',
  agent: 'https://rezics.com/id/791f2c1f-d455-4f49-993f-a208f2f16b79', role: 'author', name: 'Jane Austen' } satisfies NativeCredit;
const translator = { id: id(11), agent: id(12), role: 'translator', name: 'Native translator' } satisfies NativeCredit;
const main = id(2), head = id(3), sourceId = id(80), sourceKey = '/authors/OL113362A';
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
type Page = Static<typeof template.response>;
type Method = 'GET' | 'POST';

/** Real routes, shared executor, attribution reader and continuation, with
 * controlled graph/owner ports; this is not installed native/adoption proof. */
function fixture(native: readonly NativeCredit[] = [author]) {
  const state = { missing: false, withheld: false, deleted: false, withholdAfter: Infinity,
    nameReads: 0, source: false, reportedName: undefined as string | undefined };
  const candidates = native.map(credit => ({ id: credit.id, root: work,
    key: creditSeekKey(credit.role, 0, credit.id)!, terms: { creditRevision: [id(20)] } }));
  const refs = () => state.source ? [{ id: sourceId, key: sourceKey, ordinal: 1 }] : [];
  const meter = () => {
    const budget = fusekiReadBudget.getStore();
    if (!budget) return;
    budget.signal.throwIfAborted();
    if (budget.callsLeft <= 0) throw new FusekiReadBudgetExceeded('fixture call budget exhausted');
    budget.callsLeft--;
  };
  class Graph extends FusekiClient {
    override async commandHealth() {
      meter();
      return { moduleVersion: 'fixture', instanceId: 'fixture', publicSearchWriteEpoch: '0',
        publicSearchWriteActive: false, profiles: { 'work-metadata-v1': 'metadata-profile' } };
    }
    override async query(query: string): Promise<SparqlResult> {
      meter();
      if (query.includes('SELECT ?resource ?head WHERE')) {
        const resources = [...query.matchAll(/VALUES \?resource \{([^}]+)\}/g)].flatMap(match =>
          [...match[1]!.matchAll(/<([^>]+)>/g)].map(term => term[1]!));
        return { results: { bindings: resources.map(resource => ({ resource: uri(resource), head: uri(head) })) } };
      }
      if (query.includes('SELECT ?epoch ?sequence WHERE'))
        return { results: { bindings: [{ epoch: literal('epoch'), sequence: literal('12') }] } };
      if (query.includes('SELECT ?head ?main ?mainHead ?metadataHead ?publicationHead'))
        return { results: { bindings: [{ head: uri(head), main: uri(main), mainHead: uri(id(4)), public: literal('true') }] } };
      if (query.includes('SELECT ?structuredDecision ?structuredSource') || query.includes('SELECT ?selection ?language'))
        return { results: { bindings: [] } };
      if (query.includes('SELECT ?root ?main ?head ?mainHead ?public'))
        return { results: { bindings: [{ root: uri(work), main: uri(main), head: uri(head), mainHead: uri(id(4)), public: literal('true') }] } };
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r ?type ?work ?head'))
        return { results: { bindings: [{ epoch: literal('epoch'), sequence: literal('12'), r: uri(work),
          type: literal('work'), work: uri(work), head: uri(head), public: literal('true'),
          label: { ...literal('Retained book'), 'xml:lang': 'en' } }] } };
      if (query.includes('SELECT ?work ?head ?nameOwner') || query.includes('SELECT ?work ?head ?owningWork ?owningHead'))
        return { results: { bindings: [{ work: uri(work), head: uri(head), owningWork: uri(work), owningHead: uri(head) }] } };
      if (query.includes('SELECT ?agent ?displayName ?agentKind ?handle'))
        return { results: { bindings: native.map(credit => ({ agent: uri(credit.agent),
          displayName: literal(credit.name), agentKind: uri(`${RV}PersonAgent`), agentHead: uri(id(30)) })) } };
      throw new Error(`Unrecognized attribution fixture query: ${query}`);
    }
    override async templateQuery(envelope: TemplateQueryEnvelope): Promise<SparqlResult> {
      meter();
      return { results: { bindings: envelope.candidates!.map((candidate): ReadRow => {
        const credit = native.find(credit => credit.id === candidate.id!.value);
        if (credit) return { id: uri(credit.id), agent: uri(credit.agent), role: literal(credit.role),
          participantKind: literal('agent') };
        expect(candidate.id!.value).toBe(sourceId);
        return { id: uri(sourceId), key: literal(sourceKey), ordinal: literal('1'), role: literal('author'),
          participantKind: literal('external-reference'), provider: literal('open-library'),
          confirmation: literal('source-reported'),
          ...(state.reportedName === undefined ? {} : { displayName: literal(state.reportedName) }) };
      }) } };
    }
  }
  const graph = new Graph('http://credit-attribution-fixture.invalid');
  const nameSource = { record: id(41), observation: id(42), revision: id(43), sourceRevision: null,
    digest: 'a'.repeat(64), url: `https://openlibrary.org${sourceKey}.json`,
    fetchedAt: '2026-10-07T00:00:00Z', basis: 'facts', field: '/name' } satisfies NonNullable<Page['items'][number]['nameSource']>;
  const deps = {
    environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
      objectDirectory: '.temp/credit-attribution-unused' },
    access: { assertRecoveryOpen: async () => undefined },
    templateSeek: {
      keys: async () => [{ revision: 1 }],
      candidates: async (_epoch: string, _keys: unknown[], after: { key: string } | null, limit: number) => {
        const remaining = candidates.filter(candidate => !after || candidate.key > after.key);
        return { rows: remaining.slice(0, limit), more: remaining.length > limit };
      },
      confirmed: async () => new Set<string>(),
    },
    sourceAdoptions: { authorReferences: async () => new Map([[work, refs()]]) },
    sourceAuthorNames: { batch: async (keys: string[]) => new Map(keys.map(key => [key,
      { displayName: 'Source author name', nameSource }])) },
    profiles: { agentFences: async (agents: string[]) => new Map(
      state.missing || state.deleted ? [] : agents.map(agent => [agent, 'profile-fence'])) },
    personPreferences: { visibleNameOwners: async (agents: string[]) => {
      state.nameReads++;
      return new Set(state.withheld || state.nameReads > state.withholdAfter ? [] : agents);
    } },
    personAttributionTombstones: { read: async (agents: string[]) => new Map(state.deleted
      ? agents.map(agent => [agent, { accountErasureId: id(50), erasureId: id(51), erasureEpoch: '1' }]) : []) },
  } as unknown as MainWorkDependencies;
  const app = createMainApp(graph, deps);
  configureDisclosure(deps.environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  configureFixtureDisclosureAncestry(deps.environment, target => target.work ? { resource: target.work, head,
    ...(target.workRevision !== undefined ? { protectedRevision: target.workRevision } : {}) } : undefined);
  const call = async (method: Method, limit = 20, cursor?: string): Promise<Page> => {
    const request = method === 'POST'
      ? new Request('http://main.test/v1/query', { method, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'template-query-v1', query: template.query, revision: 1,
          parameters: { roots: [work] }, limit, cursor }) })
      : new Request(`http://main.test/v1/works/${work.slice(-36)}/credits?${new URLSearchParams({
        limit: String(limit), ...(cursor ? { cursor } : {}) })}`);
    const response = await app.handle(request);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return method === 'GET' ? body as Page : (body as { result: Page }).result;
  };
  return { call, state, nameSource };
}

for (const method of ['GET', 'POST'] as const) {
  test(`${method} credits preserve the admitted native name on its exact credit, Agent and role`, async () => {
    const f = fixture([author, translator]);
    const page = await f.call(method);
    expect(page.items).toEqual([author, translator].map(credit => ({ id: credit.id, agent: credit.agent,
      role: credit.role, participantKind: 'agent', provider: null, key: null, ordinal: null,
      displayName: credit.name, handle: null })));
    expect(page.count).toEqual({ value: 2, kind: 'exact-page', total: null });
    expect(page.complete).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  test(`${method} native names survive bounded continuation through the other shared consumer`, async () => {
    const f = fixture([author, translator]);
    const first = await f.call(method, 1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ id: author.id, agent: author.agent, role: author.role, displayName: author.name });
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBeString();
    const tail = await f.call(method === 'GET' ? 'POST' : 'GET', 1, first.nextCursor!);
    expect(tail.items).toHaveLength(1);
    expect(tail.items[0]).toMatchObject({ id: translator.id, agent: translator.agent, role: translator.role, displayName: translator.name });
    expect(tail.complete).toBe(true);
    expect(tail.nextCursor).toBeNull();
  });

  for (const state of ['withheld', 'missing'] as const) {
    test(`${method} credits omit ${state} native attribution rather than disclose its name or identity`, async () => {
      const f = fixture();
      f.state[state] = true;
      const page = await f.call(method);
      expect(page.items).toEqual([]);
      expect(page.count).toEqual({ value: 0, kind: 'exact-page', total: null });
    });
  }

  test(`${method} credits honor name withholding at the attribution owner's current check`, async () => {
    const f = fixture();
    f.state.withholdAfter = 1;
    expect((await f.call(method)).items).toEqual([]);
    expect(f.state.nameReads).toBeGreaterThanOrEqual(2);
  });

  test(`${method} credits use the retained deletion attribution without restoring the native name`, async () => {
    const f = fixture();
    f.state.deleted = true;
    expect((await f.call(method)).items).toEqual([{ id: author.id, agent: author.agent, role: author.role,
      participantKind: 'agent', provider: null, key: null, ordinal: null, displayName: 'Deleted author', handle: null }]);
  });

  test(`${method} native enrichment preserves source-reported names, provenance and fallback priority`, async () => {
    const f = fixture();
    f.state.source = true;
    const page = await f.call(method);
    expect(page.items.find(credit => credit.id === sourceId)).toEqual({ id: sourceId, agent: null,
      role: 'author', participantKind: 'external-reference', provider: 'open-library', key: sourceKey,
      ordinal: 1, displayName: 'Source author name', handle: null, confirmation: 'source-reported', nameSource: f.nameSource });
    f.state.reportedName = 'Publication-reported author';
    const reported = await f.call(method);
    expect(reported.items.find(credit => credit.id === sourceId)).toMatchObject({
      displayName: 'Publication-reported author', confirmation: 'source-reported', nameSource: f.nameSource });
    expect(reported.items.find(credit => credit.id === author.id)).toMatchObject({
      agent: author.agent, role: author.role, displayName: author.name });
  });
}
