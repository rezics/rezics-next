import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { Parser } from 'n3';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { fallbackAvatar, type ResourceSummary } from '../src/modules/media/summary.ts';
import { canonicalRelation, roleIri, type ExactDefinition } from '../src/modules/relation/change.ts';
import { readResourceRelations, RELATION_PAGE_COST } from '../src/modules/relation/traversal.ts';
import { ownedTriples, type DefinitionState } from '../src/modules/semantic/change.ts';
import { definitionKindIri, PROFILES } from '../src/modules/semantic/schema.ts';
import { StaleSemanticHead } from '../src/modules/semantic/command.ts';
import { prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import { resourceRelationRoutes } from '../src/routes/resource-relations.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const root = `.temp/relation-selection-${Bun.randomUUIDv7()}`;
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
const values = (query: string, variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`, 'u')
  .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/gu)].map(match => match[1]!);

/** Only storage/access ports are controlled: immutable occurrence/Definition
 * reads, native projection validation, rendering, selection and fences are real. */
function fixture() {
  const objectDirectory = mkdtempSync(`${root}/objects-`);
  const graph = new FusekiClient('http://graph.invalid');
  const env: WorkActivationEnvironment = { fuseki: graph, objectDirectory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  const hidden = new Set<string>(), denied = new Set<string>(), queries: string[] = [], payloads: string[] = [];
  const control = { epoch: 'epoch', sequence: '1' };
  const definitions = [10, 20].map(number => {
    const definition = id(number), revision = id(number + 1);
    const state: DefinitionState = { component: 'definition', kind: 'relation', lifecycle: 'active',
      successor: null, roles: ['hub', 'variant', 'kind'].map(key => ({ key,
        minParticipants: key === 'kind' ? 0 : 1, maxParticipants: 1, ordered: false })) };
    const exact: ExactDefinition = { definition, revision, kind: 'relation', lifecycle: 'active',
      roles: state.roles.map(({ key, ...role }) => ({ ...role, role: roleIri(definition, key) })),
      roleKeys: Object.fromEntries(state.roles.map(role => [roleIri(definition, role.key), role.key])) };
    return { definition, revision, state, exact,
      manifest: `urn:rezics:sha256:${prepareComponent(objectDirectory, definition, state, PROFILES.definition)}` };
  });
  type Occurrence = { relation: string; head: string; manifest: string; score: number;
    state: ReturnType<typeof canonicalRelation> };
  const occurrences: Occurrence[] = [];
  const add = (number: number, definition = definitions[0]!, resource = id(1), viewingRole = 'hub', counterpart = id(2), score = 0) => {
    const relation = id(number), head = id(number + 10000);
    const state = canonicalRelation(definition.exact, { definition: definition.revision, participations: [
      { role: viewingRole, participant: { kind: 'resource', ref: resource } },
      { role: viewingRole === 'hub' ? 'variant' : 'hub', participant: { kind: 'resource', ref: counterpart } },
    ] });
    state.participations.forEach((part, index) => { part.iri = id(number * 10 + 100000 + index); });
    // Withheld and unrelated indexed candidates need no payload fixture. Seal
    // the exact native bytes only when a disclosed occurrence is hydrated.
    const item = { relation, head, score, state, manifest: '' };
    occurrences.push(item);
    return item;
  };
  const rdfRows = (subject: string, triples: string[]) => rows(new Parser()
    .parse(triples.map(triple => `<${subject}> ${triple} .`).join('\n')).map(quad => ({
      p: uri(quad.predicate.value), o: quad.object.termType === 'NamedNode' ? uri(quad.object.value)
        : { ...literal(quad.object.value), datatype: quad.object.termType === 'Literal' ? quad.object.datatype.value : undefined },
    })));
  graph.query = async query => {
    queries.push(query);
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT DISTINCT ?relation ?kind ?key')) {
      const resource = /\?part rv:participant <([^>]+)>/u.exec(query)![1]!;
      const selectedDefinition = /\?selectedDefinitionRevision a rv:DefinitionRevision ; rv:component <([^>]+)>/u.exec(query)?.[1];
      const selectedRole = /\?part rv:role <([^>]+)>/u.exec(query)?.[1];
      const after = /\?key > "([^"]+)"/u.exec(query)?.[1];
      const afterScore = /\?specificity < (\d+)/u.exec(query)?.[1];
      const framed = query.includes('SELECT DISTINCT ?relation ?kind ?key ?specificity');
      // Indexed incidence and selector constraints apply before LIMIT. Hundreds
      // of unrelated rows therefore cannot exhaust the selected scan budget.
      const found = occurrences.filter(item => item.state.participations.some(part =>
        part.participant.kind === 'resource' && part.participant.ref === resource && (!selectedRole || part.role === selectedRole))
        && (!selectedDefinition || definitions.find(definition => definition.revision === item.state.definition)?.definition === selectedDefinition))
        .sort((a, b) => (framed ? b.score - a.score : 0) || a.relation.localeCompare(b.relation))
        .filter(item => !after || (framed && item.score < Number(afterScore))
          || (!framed || item.score === Number(afterScore)) && `occurrence:${item.relation}` > after)
        .slice(0, RELATION_PAGE_COST.scanLimit);
      return rows(found.map(item => ({ relation: uri(item.relation), kind: literal('occurrence'),
        key: literal(`occurrence:${item.relation}`), ...(framed ? { specificity: literal(String(item.score)) } : {}) })));
    }
    if (query.includes('SELECT ?head ?manifest ?model')) {
      const definition = definitions.find(item => query.includes(`<${item.definition}>`));
      if (definition) return rows([{ head: uri(definition.revision), manifest: uri(definition.manifest) }]);
      const occurrence = occurrences.find(item => query.includes(`<${item.relation}>`));
      if (occurrence) {
        payloads.push(occurrence.relation);
        occurrence.manifest ||= `urn:rezics:sha256:${prepareComponent(objectDirectory, occurrence.relation, occurrence.state, PROFILES.relation)}`;
        return rows([{ head: uri(occurrence.head), manifest: uri(occurrence.manifest) }]);
      }
      return rows([]);
    }
    if (query.includes('SELECT ?definition ?manifest ?kind')) {
      const definition = definitions.find(item => query.includes(`<${item.revision}>`));
      return rows(definition ? [{ definition: uri(definition.definition), manifest: uri(definition.manifest),
        kind: uri(definitionKindIri('relation')) }] : []);
    }
    if (query.includes('SELECT ?p ?o')) {
      const definition = definitions.find(item => query.includes(`<${item.definition}>`));
      if (definition) return rdfRows(definition.definition, ownedTriples(definition.definition, definition.state, definition.revision));
      const occurrence = occurrences.find(item => query.includes(`<${item.relation}>`))!;
      return rdfRows(occurrence.relation, [`<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${RV}RelationOccurrence>`,
        `<${RV}relationDefinition> <${occurrence.state.definition}>`, `<${RV}occurrenceHead> <${occurrence.head}>`]);
    }
    if (query.includes('SELECT ?presentation ?head ?language')) return rows([]);
    if (query.includes('SELECT ?resource ?head')) return rows(values(query, 'resource').map(resource => ({ resource: uri(resource), head: uri(id(90)) })));
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return rows(values(query, 'r').map(resource => ({
      epoch: literal(control.epoch), sequence: literal(control.sequence), r: uri(resource), type: literal('concept'),
      public: literal('true'), label: { ...literal('Native resource'), 'xml:lang': 'en' },
    })));
    if (query.includes('SELECT ?epoch ?sequence')) return rows([{ epoch: literal(control.epoch), sequence: literal(control.sequence) }]);
    throw new Error(`Unexpected relation query: ${query.slice(0, 180)}`);
  };
  configureFixtureDisclosureAncestry(env, () => undefined);
  configureDisclosure(env, fixtureDisclosureReader(async targets => targets.map(target => hidden.has(target.resource) ? 'hidden' : 'visible')));
  const canRead = async (resource: string) => !denied.has(resource);
  const disclose = async (resources: readonly string[]) => new Set(resources.filter(resource => !denied.has(resource) && !hidden.has(resource)));
  let afterSummaries = () => {};
  const summarize = async (resources: string[]): Promise<ResourceSummary[]> => {
    const summaries: ResourceSummary[] = resources.map(reference => ({ status: 'available', reference, type: 'concept',
      base: null, work: null, disclosure: 'public', name: { value: 'Native resource', language: 'en', direction: 'ltr', basis: 'fallback' },
      avatar: fallbackAvatar('concept', reference), address: { prefix: '/e/', key: reference.slice(-36), suffixSource: 'Native resource' } }));
    afterSummaries();
    return summaries;
  };
  const input = { resource: id(1), languages: ['en'], limit: 2, definition: definitions[0]!.definition, viewingRole: 'hub',
    canRead, canReadOccurrence: canRead, disclose, summarize, readingPosition: 'reader:public:all' };
  const deps = { environment: env, access: { canReadSemanticResource: async (_principal: unknown, _actor: unknown, resource: string) => canRead(resource),
    assertRecoveryOpen: async () => {}, activePrincipalId: async () => 'reader' } } as unknown as MainWorkDependencies;
  const read = (overrides: Partial<typeof input> & { after?: string } = {}) => readResourceRelations(env, { ...input, ...overrides });
  return { env, graph, deps, input, read, add, definitions, occurrences, queries, payloads, hidden, denied, control,
    afterSummaries: (callback: () => void) => { afterSummaries = callback; } };
}

test('exact family selection runs before scan/page limits, keeps repeats and leaves mixed unselected incidences intact', async () => {
  const f = fixture();
  for (let index = 0; index < 850; index++) f.add(100 + index, f.definitions[1]);
  const first = f.add(1000), second = f.add(1001), third = f.add(1002);
  f.add(1003, f.definitions[0], id(1), 'variant');
  const page = await f.read();
  expect(page.items.map(item => item.relation)).toEqual([first.relation, second.relation]);
  expect(page.items.map(item => item.counterparts[0]!.reference)).toEqual([id(2), id(2)]);
  expect(page.items.map(item => item.revision)).toEqual([first.head, second.head]);
  expect(page.items[0]!.rendering).toMatchObject({ meaning: { definition: f.input.definition,
    revision: f.definitions[0]!.revision }, viewingRole: 'hub' });
  expect(f.payloads).toEqual([first.relation, second.relation, third.relation]);
  expect(f.queries.filter(query => query.includes('SELECT DISTINCT ?relation'))).toHaveLength(1);
  expect(page.next).not.toBeNull();
  const last = await f.read({ after: page.next! });
  expect(last.items.map(item => item.relation)).toEqual([third.relation]); expect(last.next).toBeNull();
  const discovery = await f.read({ viewingRole: 'variant' });
  expect(discovery.items.map(item => item.relation)).toEqual([id(1003)]);
  const unselected = await f.read({ definition: undefined, viewingRole: undefined });
  expect(unselected.items.map(item => item.relation)).toEqual([id(100), id(101)]);
  const legacyBinding = createHash('sha256').update(JSON.stringify([id(1), 2, ['en'], undefined, f.input.readingPosition])).digest('hex');
  expect(JSON.parse(Buffer.from(unselected.next!, 'base64url').toString()).binding).toBe(legacyBinding);
  expect((await f.read({ definition: undefined, viewingRole: undefined, after: unselected.next! })).items[0]!.relation).toBe(id(102));
  const unselectedQuery = f.queries.filter(query => query.includes('SELECT DISTINCT ?relation')).at(-1)!;
  expect(unselectedQuery).toContain('rv:AuthorCredit'); expect(unselectedQuery).toContain('rv:OccurrencePlacement');
});

test('opaque selected continuation binds the complete selector, reader, resource, order, frame and source position', async () => {
  const f = fixture(); f.add(100); f.add(101); f.add(102);
  const page = await f.read();
  for (const overrides of [{ definition: f.definitions[1]!.definition }, { viewingRole: 'variant' }, { readingPosition: 'reader:other:all' },
    { readingPosition: 'reader:public:start' }, { resource: id(2) }, { limit: 1 }, { languages: ['ja'] },
    { definition: undefined, viewingRole: undefined }]) {
    await expect(f.read({ ...overrides, after: page.next! })).rejects.toThrow();
  }
  await expect(f.read({ after: `${page.next!.slice(0, -3)}abc` })).rejects.toThrow();
  const session = new WorkReadSession(f.deps, new Request('http://main.local?position=all'), {}, { dataEpoch: 'epoch', sequence: '1' });
  await expect(readResourceRelations(f.env, { ...f.input, after: page.next!, frames: [{ iri: id(9), dimension: 'continuity', work: id(8) }] }, session))
    .rejects.toThrow();
  f.control.sequence = '2'; await expect(f.read({ after: page.next! })).rejects.toThrow('restart');
  f.control.sequence = '1'; f.control.epoch = 'restored'; await expect(f.read({ after: page.next! })).rejects.toThrow('restart');
});

test('selected hidden scan windows return empty opaque continued pages and resume the exact occurrence frontier', async () => {
  const f = fixture();
  for (let index = 0; index < RELATION_PAGE_COST.scanLimit * RELATION_PAGE_COST.maxScans; index++) {
    f.hidden.add(f.add(100 + index).relation);
  }
  const visible = f.add(1000), page = await f.read();
  expect(page.items).toEqual([]); expect(page.next).not.toBeNull();
  expect(f.payloads).toEqual([]);
  expect(f.queries.filter(query => query.includes('SELECT DISTINCT ?relation'))).toHaveLength(RELATION_PAGE_COST.maxScans);
  const bytes = Buffer.from(page.next!, 'base64url').toString();
  expect(bytes).not.toContain(id(899)); expect(bytes).not.toContain('occurrence:');
  expect((await f.read({ after: page.next! })).items.map(item => item.relation)).toEqual([visible.relation]);
  f.hidden.add(visible.relation);
  const end = await f.read({ after: page.next! }); expect(end.items).toEqual([]); expect(end.next).toBeNull();
});

test('selection refuses inconsistent inputs and hidden Definition roles without disclosing retained diagnostics', async () => {
  const f = fixture(); f.add(100);
  for (const overrides of [{ definition: undefined }, { viewingRole: undefined }, { viewingRole: 'missing' },
    { viewingRole: 'hub/escape' }, { definition: id(999) }]) {
    await expect(f.read(overrides)).rejects.toThrow();
  }
  expect(f.payloads).toEqual([]);
  f.hidden.add(f.input.definition); f.queries.length = 0;
  await expect(f.read({ viewingRole: 'missing' })).rejects.toThrow('unavailable');
  expect(f.queries.some(query => query.includes('SELECT ?head ?manifest'))).toBe(false);
});

test('selected participant, occurrence, Definition and selected-result fences preserve current disclosure', async () => {
  const f = fixture(); const first = f.add(100), second = f.add(101, f.definitions[0], id(1), 'hub', id(3));
  f.denied.add(id(2));
  expect((await f.read()).items.map(item => item.relation)).toEqual([second.relation]);
  f.denied.delete(id(2)); f.denied.add(first.relation);
  expect((await f.read()).items.map(item => item.relation)).toEqual([second.relation]);
  f.denied.clear(); f.afterSummaries(() => f.denied.add(id(2)));
  await expect(f.read()).rejects.toBeInstanceOf(StaleSemanticHead);
  f.denied.clear(); f.afterSummaries(() => f.hidden.add(f.input.definition));
  await expect(f.read()).rejects.toThrow('unavailable');
  f.hidden.clear(); f.afterSummaries(() => {});
  const session = new WorkReadSession(f.deps, new Request('http://main.local?position=all'), {}, { dataEpoch: 'epoch', sequence: '1' });
  await readResourceRelations(f.env, f.input, session);
  f.denied.add(id(2)); await expect(session.fenceDependencies()).rejects.toThrow('Selected dependency changed');
});

test('framed selected pages keep specificity and exact repeated occurrence order through continuation', async () => {
  const f = fixture(); f.add(100, f.definitions[0], id(1), 'hub', id(2), 0);
  f.add(101, f.definitions[0], id(1), 'hub', id(2), 17); f.add(102, f.definitions[0], id(1), 'hub', id(2), 17);
  const input = { ...f.input, frames: [{ iri: id(9), dimension: 'continuity' as const, work: id(8) }] };
  const page = await readResourceRelations(f.env, input);
  expect(page.items.map(item => item.relation)).toEqual([id(101), id(102)]);
  expect(page.items.map(item => item.frameMatch)).toEqual([{ dimensions: 1, exact: 1, score: 17 }, { dimensions: 1, exact: 1, score: 17 }]);
  const next = await readResourceRelations(f.env, { ...input, after: page.next! });
  expect(next.items.map(item => item.relation)).toEqual([id(100)]); expect(next.next).toBeNull();
});

test('resource relation route composes exact selected/unselected reads and existing invalid/stale problems', async () => {
  const f = fixture(); f.add(100, f.definitions[1]); f.add(101); f.add(102); f.add(103);
  const app = resourceRelationRoutes(f.graph, f.deps);
  const request = (parameters: Record<string, string> = {}) => app.handle(new Request(`http://localhost/v1/resources/${id(1).slice(-36)}/relations?${new URLSearchParams({
    position: 'all', limit: '2', ...parameters })}`));
  const selector = { definition: f.input.definition, viewingRole: 'hub' };
  const selected = await request(selector); expect(selected.status).toBe(200);
  const page = await selected.json(); expect(page.items.map((item: { relation: string }) => item.relation)).toEqual([id(101), id(102)]);
  const continued = await request({ ...selector, after: page.next }); expect(continued.status).toBe(200);
  expect((await continued.json()).items.map((item: { relation: string }) => item.relation)).toEqual([id(103)]);
  const mixed = await request(); expect(mixed.status).toBe(200);
  expect((await mixed.json()).items.map((item: { relation: string }) => item.relation)).toEqual([id(100), id(101)]);
  expect((await request({ definition: selector.definition })).status).toBe(400);
  expect((await request({ ...selector, viewingRole: 'missing' })).status).toBe(400);
  expect((await request({ ...selector, viewingRole: 'hub/escape' })).status).toBe(422);
  expect((await request({ ...selector, viewingRole: 'variant', after: page.next })).status).toBe(400);
  f.control.sequence = '2'; expect((await request({ ...selector, after: page.next })).status).toBe(409);
});

test('hidden and absent selected Definitions have the same unavailable route response before role diagnostics', async () => {
  const f = fixture(); f.add(100);
  const app = resourceRelationRoutes(f.graph, f.deps);
  f.hidden.add(f.input.definition);
  const request = (definition: string, viewingRole: string) => app.handle(new Request(
    `http://localhost/v1/resources/${id(1).slice(-36)}/relations?${new URLSearchParams({
      position: 'all', definition, viewingRole })}`));
  for (const role of ['hub', 'missing']) {
    const hidden = await request(f.input.definition, role);
    const absent = await request(id(999), role);
    expect(hidden.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await hidden.json()).toEqual(await absent.json());
  }
  expect(f.payloads).toEqual([]);
});
