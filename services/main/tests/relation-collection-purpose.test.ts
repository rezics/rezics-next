import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Parser } from 'n3';
import { Value } from 'typebox/value';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { readCollectionPurpose, renderCollectionIncidence } from '../src/modules/collection/purpose.ts';
import { readPageRelations } from '../src/modules/entity-page/relations.ts';
import { resourceRelationEntry } from '../src/modules/entity-page/contract.ts';
import { identityCanonical } from '../src/modules/address/canonical.ts';
import { FALLBACK_POLICY, type ResourceSummary } from '../src/modules/media/summary.ts';
import { readResourceRelations } from '../src/modules/relation/traversal.ts';
import { ownedTriples, type DefinitionState } from '../src/modules/semantic/change.ts';
import { PROFILES, definitionKindIri } from '../src/modules/semantic/schema.ts';
import { COLLECTION_PURPOSE_KINDS, COLLECTION_PURPOSE_NOTATION } from '../src/modules/statement/qualification.ts';
import { decisionSlotIri, STATEMENT_PROFILE, statementMeaningKey, type StatementMeaning } from '../src/modules/statement/schema.ts';
import { CLASSIFICATION_INHERIT_POLICY, GLOBAL_CLASSIFICATION_CONTEXT } from '../src/modules/classification/context.ts';
import { WorkReadSession, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { readSubjectStatements } from '../src/modules/statement/subject-read.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type StructureManifest } from '../src/modules/structure/format.ts';
import { orderTreeKey, type CompositionHeader } from '../src/modules/structure/graph.ts';
import { readCompositionPage } from '../src/modules/structure/read.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const root = resolve('.temp', `collection-purpose-${Bun.randomUUIDv7()}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
const values = (query: string, variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`, 'u')
  .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/gu)].map(match => match[1]!);

/** Only external graph/access/index transport is substituted. Native definition
 * manifests, Statement value/key verification, current adoption, bounded reads,
 * disclosure, traversal and selected-result fences execute their real owners. */
function fixture() {
  const objectDirectory = mkdtempSync(`${root}/objects-`);
  const graph = new FusekiClient('http://graph.invalid');
  const env: WorkActivationEnvironment & { structureObjects?: ImmutableObjects } = { fuseki: graph, objectDirectory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  const definition = id(2), member = id(1), collection = id(10);
  let head = id(3), keyPresent = true, coverage = true, deadline = false, collectionActive = true;
  let state: DefinitionState = { component: 'definition', kind: 'property', lifecycle: 'active',
    successor: null, roles: [], notation: COLLECTION_PURPOSE_NOTATION };
  let manifest = '';
  const claims: Array<{ statement: string; collection: string; revision: string; key: string;
    value: StatementMeaning['value']; relation: string; manifest: string;
    acceptance: 'accepted' | 'rejected' | 'withdrawn' | 'unavailable' | null;
    sources: string[]; active: boolean; private: boolean }> = [];
  const hidden = new Set<string>(), queries: string[] = [], hydration: string[][] = [];
  const citationReads: string[][] = [];
  let membershipHeader: CompositionHeader | undefined;
  const collections = [collection];
  const reseal = () => { manifest = `urn:rezics:sha256:${prepareComponent(objectDirectory, definition, state, PROFILES.definition)}`; };
  reseal();
  const add = (kind: string, target = collection, sources: string[] = []) => {
    const statement = id(100 + claims.length), revision = id(1000 + claims.length);
    const meaning: StatementMeaning = { subject: target, predicate: definition, relationDefinition: head,
      interpretationDefinitions: [], applicability: [], value: { kind: 'literal', lexical: kind,
        datatype: `${XSD}string`, language: null } };
    const key = statementMeaningKey(meaning);
    const claim = { statement, collection: target, revision, key, value: meaning.value, relation: head,
      manifest: `urn:rezics:sha256:${prepareComponent(objectDirectory, statement, { meaning, meaningKey: key }, STATEMENT_PROFILE)}`,
      acceptance: 'accepted' as 'accepted' | 'rejected' | 'withdrawn' | 'unavailable' | null,
      sources, active: true, private: false };
    claims.push(claim);
    return claim;
  };
  graph.query = async query => {
    queries.push(query);
    if (query.includes('SELECT ?structure WHERE')) {
      const index = collections.findIndex(ref => query.includes(`<${ref}>`));
      return rows(collectionActive && index >= 0 ? [{ structure: uri(id(2000 + index)) }] : []);
    }
    if (query.includes('SELECT ?component ?profile ?head ?generation ?count ?manifest')) {
      const index = collections.findIndex((_ref, index) => query.includes(`<${id(2000 + index)}>`));
      return rows(index < 0 ? [] : [{ component: uri(collections[index]!), profile: uri(`${RV}CollectionMembership`),
        head: uri(id(3000 + index)), generation: uri(id(4000 + index)), count: literal('3'),
        manifest: uri(index === 0 && membershipHeader ? membershipHeader.manifest : `urn:rezics:sha256:${'2'.repeat(64)}`) }]);
    }
    if (query.includes('SELECT ?manifest ?predecessor') && membershipHeader) return rows([{
      manifest: uri(membershipHeader.manifest), count: literal(String(membershipHeader.placementCount)),
      epoch: literal('epoch'), sequence: literal('1'),
    }]);
    if (query.includes('SELECT ?owner WHERE')) {
      const index = collections.findIndex(ref => query.includes(`<${ref}>`));
      return rows(index < 0 ? [] : [{ owner: uri(collections[index]!) }]);
    }
    if (query.includes('SELECT ?definition ?head')) return rows(keyPresent ? [{ definition: uri(definition), head: uri(head) }] : []);
    if (query.includes('SELECT ?definition ?manifest ?kind')) return rows([{ definition: uri(definition),
      manifest: uri(manifest), kind: uri(definitionKindIri(state.kind)) }]);
    if (query.includes('SELECT ?head ?manifest')) return rows(query.includes(`<${definition}>`) ? [{ head: uri(head), manifest: uri(manifest) }] : []);
    if (query.includes('SELECT ?p ?o')) return rows(new Parser().parse(ownedTriples(definition, state, head)
      .map(triple => `<${definition}> ${triple} .`).join('\n')).map(quad => ({ p: uri(quad.predicate.value),
        o: quad.object.termType === 'NamedNode' ? uri(quad.object.value)
          : { ...literal(quad.object.value), datatype: quad.object.termType === 'Literal' ? quad.object.datatype.value : undefined } })));
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?resource ?head')) return rows(values(query, 'resource').map(resource => ({ resource: uri(resource), head: uri(id(80)) })));
    if (query.includes('SELECT ?policy ?realm')) return rows([{ policy: uri(CLASSIFICATION_INHERIT_POLICY) }]);
    if (query.includes('SELECT ?epoch ?sequence ?context ?policy')) return rows([{ epoch: literal('epoch'), sequence: literal('1'),
      context: uri(GLOBAL_CLASSIFICATION_CONTEXT), policy: uri(CLASSIFICATION_INHERIT_POLICY) }]);
    if (query.includes('SELECT ?epoch ?sequence ?statement ?localSlot')) {
      const targets = [...new Set([...query.matchAll(/\(<([^>]+)>\s+rv:(?:StatementTarget|QualifiedFactTarget)/gu)]
        .map(match => match[1]!))];
      return rows(targets.map(target => {
        const claim = claims.find(claim => claim.statement === target);
        return { epoch: literal('epoch'), sequence: literal('1'), statement: uri(target),
          ...(claim?.acceptance ? { globalSlot: uri(decisionSlotIri({ kind: 'statement', statement: target },
            GLOBAL_CLASSIFICATION_CONTEXT)), ...(claim.acceptance === 'unavailable' ? {} : {
            globalDecision: uri(id(801 + claims.indexOf(claim))),
            globalOutcome: uri(`${RV}${{ accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn' }[claim.acceptance]}`),
          }) } : {}) };
      }));
    }
    if (query.includes('?neighbourScore')) {
      if (deadline) throw new WorkReadUnavailable('Statement read budget exceeded');
      if (query.includes('FILTER(?predicate =')) expect(query).toContain(`FILTER(?predicate = <${definition}>)`);
      const target = /rdf:subject <([^>]+)>/u.exec(query)?.[1];
      const after = /STR\(\?statement\) > "([^"]+)"/u.exec(query)?.[1];
      const selected = claims.filter(claim => claim.active && claim.collection === target)
        .sort((a, b) => a.key.localeCompare(b.key) || a.statement.localeCompare(b.statement));
      const offset = after ? selected.findIndex(claim => claim.statement === after) + 1 : 0;
      return rows(selected.slice(offset, offset + 20).map(claim => ({ statement: uri(claim.statement),
        predicate: uri(definition), key: uri(claim.key), neighbourScore: literal('0') })));
    }
    if (query.includes('SELECT ?statement ?predicate ?object')) {
      const ids = values(query, 'statement'); hydration.push(ids);
      return rows(ids.flatMap(statement => {
        const claim = claims.find(claim => claim.statement === statement)!;
        if (!claim.active) return [];
        return [{ statement: uri(statement), predicate: uri(definition), object: claim.value.kind === 'literal'
          ? { ...literal(claim.value.lexical), datatype: claim.value.datatype,
            ...(claim.value.language ? { 'xml:lang': claim.value.language } : {}) } : uri(`${RV}NoValue`),
          relation: uri(claim.relation), speaker: uri(id(4)), key: uri(claim.key), head: uri(claim.revision), manifest: uri(claim.manifest),
          definitions: literal(''), qualifiers: literal(''), valueQualifiers: literal(''), sources: literal(claim.sources.join('|')),
          ...(claim.private ? { pin: uri(id(70)), ctx: uri(id(71)), disclosure: uri(`${RV}Private`) } : {}) }];
      }));
    }
    if (query.includes('SELECT DISTINCT ?relation ?kind ?key')) {
      const after = /FILTER\(\?key > "([^"]+)"\)/u.exec(query)?.[1];
      return rows(collections.filter(collection => !after || `collection:${collection}` > after)
        .map(collection => ({ relation: uri(collection), kind: literal('collection'), key: literal(`collection:${collection}`) })));
    }
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return rows(values(query, 'r').map(ref => ({
      epoch: literal('epoch'), sequence: literal('1'), r: uri(ref), type: literal(collections.includes(ref) ? 'collection' : 'work'),
      ...(collections.includes(ref) ? {} : { work: uri(ref), head: uri(id(80)) }),
      label: { ...literal('A series named by its curator'), 'xml:lang': 'en' },
      public: literal('true'), erased: literal('false'),
    })));
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) return rows(values(query, 'r').map(ref => ({
      epoch: literal('epoch'), sequence: literal('1'), r: uri(ref), revision: uri(id(80)), type: uri('https://schema.org/CreativeWork'),
    })));
    if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) return rows(values(query, 'work').map(work => ({
      work: uri(work), head: uri(id(80)), owningWork: uri(work), owningHead: uri(id(80)),
    })));
    if (query.includes('SELECT ?epoch ?sequence')) return rows([{ epoch: literal('epoch'), sequence: literal('1') }]);
    throw new Error(`Unexpected Collection purpose graph read: ${query}`);
  };
  configureFixtureDisclosureAncestry(env, target => target.work
    ? { resource: target.work, head: id(80), protectedRevision: target.workRevision } : undefined);
  configureDisclosure(env, fixtureDisclosureReader(async targets => targets.map(target => hidden.has(target.resource) ? 'hidden' : 'visible')));
  const deps = { environment: env, access: { assertRecoveryOpen: async () => {}, canReadWork: async () => false,
    canReadSemanticResource: async (_principal: unknown, _actor: unknown, ref: string) => !hidden.has(ref) },
    wikiEvidence: { forClaims: async (refs: string[]) => {
      citationReads.push(refs);
      if (refs.some(ref => hidden.has(ref) || claims.find(claim => claim.statement === ref)?.private))
        throw new Error('Unreadable Statement must not request citation data');
      return [];
    }, withheld: async () => new Set<string>() },
    statementSeek: { coverage: async () => ({ complete: coverage, through_sequence: '0' }) },
  } as unknown as MainWorkDependencies;
  const session = (options: ConstructorParameters<typeof WorkReadSession>[2] = {}) => new WorkReadSession(deps,
    new Request('http://main.local/v1/resources/relations'), { languages: 'en', ...options }, { dataEpoch: 'epoch', sequence: '1' });
  const summary = (refs: string[]): Promise<ResourceSummary[]> => Promise.resolve(refs.map(reference => ({
    reference, status: 'available', type: 'work', base: 'work', work: reference, disclosure: 'public',
    address: identityCanonical('work', reference, 'A series named by its curator'),
    name: { value: 'A series named by its curator', language: 'en', direction: 'ltr', basis: 'requested' },
    avatar: { kind: 'fallback', policy: FALLBACK_POLICY, key: reference, resourceType: 'work' },
  })));
  const direct = (read: WorkReadSession, limit = 4, after?: string) => readResourceRelations(env, {
    resource: member, languages: ['en'], limit, after, readingPosition: 'public-selection',
    canRead: async ref => !hidden.has(ref), canReadOccurrence: async ref => !hidden.has(ref),
    disclose: async refs => new Set(refs.filter(ref => !hidden.has(ref))), summarize: summary,
  }, read);
  const membership = async () => {
    const stored = new Map<string, Uint8Array>();
    const objects: ImmutableObjects = { async put(bytes) {
      const digest = createHash('sha256').update(bytes).digest('hex'); stored.set(digest, bytes); return digest;
    }, async get(digest) { const bytes = stored.get(digest); if (!bytes) throw new Error('Missing membership object'); return bytes; } };
    env.structureObjects = objects;
    const structure = id(2000), revision = id(3000), generation = id(4000);
    const records: OccurrenceRecord[] = Array.from({ length: 3 }, (_, index) => ({ occurrence: id(500 + index),
      parent: structure, state: 'active', role: 'member', segmentKey: 'i', orderKey: String(index).padStart(8, '0'),
      labels: [], introducedBy: revision, target: member, selection: { mode: 'follow-context' } }));
    const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
    const entries = records.map(row => ({ occurrence: row.occurrence, parent: row.parent,
      segmentKey: row.segmentKey!, orderKey: row.orderKey! }));
    const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: collection,
      profile: 'collection-membership', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
      records: await recordIndex.apply(await recordIndex.empty(cost), new Map(records.map(row => [row.occurrence, row])), cost),
      order: await orderIndex.apply(await orderIndex.empty(cost), new Map(entries.map(row => [orderTreeKey(row), row])), cost),
      placementCount: records.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
    const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
    membershipHeader = { structure, head: revision, generation, manifest: `urn:rezics:sha256:${digest}`,
      placementCount: records.length, profile: 'collection-membership', owner: collection, component: collection,
      work: collection, mainVersion: collection };
    return { records, read: (after?: string) => readCompositionPage(env, { structure, header: membershipHeader,
      after, limit: 1, canReadTarget: async target => target === member }) };
  };
  return { env, member, collection, definition, claims, collections, queries, hydration, citationReads,
    hidden, add, session, direct, membership,
    hideDefinition() { keyPresent = false; }, incomplete() { coverage = false; }, exhaustBudget() { deadline = true; },
    retireCollection() { collectionActive = false; },
    retireDefinition() { state = { ...state, lifecycle: 'retired' }; head = id(5); reseal(); },
    advanceDefinition() { head = id(5); reseal(); },
  };
}

for (const kind of COLLECTION_PURPOSE_KINDS) test(`Collection incidence preserves the current adopted ${kind} assertion and native sources`, async () => {
  const run = fixture(), claim = run.add(kind);
  const result = await run.direct(run.session());
  expect(result.items[0]?.collectionPurpose).toEqual({ kind, statement: claim.statement, revision: claim.revision, sources: [] });
  expect(result.items[0]?.rendering?.bindings).toEqual([
    { role: 'member', participant: { kind: 'resource', ref: run.member } },
    { role: 'collection', participant: { kind: 'resource', ref: run.collection } },
  ]);
  expect(Value.Check(resourceRelationEntry, result.items[0])).toBe(true);
});

test('a misleading Collection title, proposals and rejected or withdrawn adoption remain neutral', async () => {
  const run = fixture();
  expect((await run.direct(run.session())).items[0]?.collectionPurpose).toBeNull();
  const claim = run.add('franchise');
  for (const acceptance of [null, 'rejected', 'withdrawn'] as const) {
    claim.acceptance = acceptance;
    const entry = (await run.direct(run.session())).items[0]!;
    expect(entry.collectionPurpose).toBeNull();
    expect(entry.rendering?.projections[0]?.labels?.heading).toBe('Collections');
  }
  claim.acceptance = 'accepted'; claim.active = false;
  expect((await run.direct(run.session())).items[0]?.collectionPurpose).toBeNull();
});

test('the finite property owner proves absence beyond the first ordinary fact page', async () => {
  const run = fixture();
  for (let index = 0; index < 65; index++) run.add('series').acceptance = null;
  expect(await readCollectionPurpose(run.session({ limit: 1, cursor: 'unrelated-page' }), run.collection)).toBeNull();
  const claim = run.add('reading-list');
  expect(await readCollectionPurpose(run.session({ limit: 1 }), run.collection)).toMatchObject({ statement: claim.statement });
  expect(run.queries.filter(query => query.includes('?neighbourScore')).length).toBeGreaterThan(4);
  expect(Math.max(...run.hydration.map(batch => batch.length))).toBeLessThanOrEqual(20);
});

test('invalid, duplicate visible, stale or retired meaning and incomplete owner reads refuse explicitly', async () => {
  const invalid = fixture(); invalid.add('a series');
  await expect(readCollectionPurpose(invalid.session(), invalid.collection)).rejects.toThrow('value is invalid');
  const duplicate = fixture(); duplicate.add('series'); duplicate.add('series');
  await expect(readCollectionPurpose(duplicate.session(), duplicate.collection)).rejects.toThrow('ambiguous');
  const stale = fixture(); stale.add('series'); stale.advanceDefinition();
  await expect(readCollectionPurpose(stale.session(), stale.collection)).rejects.toThrow('meaning is unavailable');
  const retired = fixture(); retired.retireDefinition();
  await expect(readCollectionPurpose(retired.session(), retired.collection)).rejects.toThrow('definition is unavailable');
  const undefinedMeaning = fixture(); undefinedMeaning.hideDefinition();
  await expect(readCollectionPurpose(undefinedMeaning.session(), undefinedMeaning.collection)).rejects.toThrow('definition is unavailable');
  const unavailable = fixture(); unavailable.add('series').acceptance = 'unavailable';
  await expect(readCollectionPurpose(unavailable.session(), unavailable.collection)).rejects.toThrow('acceptance is unavailable');
  const missing = fixture(); missing.incomplete();
  await expect(readCollectionPurpose(missing.session(), missing.collection)).rejects.toThrow('coverage is corrupt');
  const exhausted = fixture(); exhausted.exhaustBudget();
  await expect(readCollectionPurpose(exhausted.session(), exhausted.collection)).rejects.toThrow('budget exceeded');
});

test('hidden/private assertions do not change public purpose or leak unavailable adoption', async () => {
  const run = fixture(), visible = run.add('series'), hidden = run.add('franchise'), privateClaim = run.add('recipe-selection');
  run.hidden.add(hidden.statement); hidden.acceptance = 'unavailable'; privateClaim.private = true;
  const read = run.session();
  expect(await readCollectionPurpose(read, run.collection)).toMatchObject({ statement: visible.statement });
  hidden.acceptance = 'accepted'; privateClaim.acceptance = 'unavailable';
  await expect(read.fenceDependencies()).resolves.toBeUndefined();
  run.hidden.add(visible.statement);
  expect(await readCollectionPurpose(run.session(), run.collection)).toBeNull();
  expect(run.citationReads.flat()).not.toContain(hidden.statement);
  expect(run.citationReads.flat()).not.toContain(privateClaim.statement);
});

test('unreadable Context values and sources cannot make an otherwise neutral public Collection fail', async () => {
  const run = fixture(), claim = run.add('series'); claim.private = true;
  claim.acceptance = 'unavailable';
  claim.value = { kind: 'literal', lexical: 'invalid', datatype: `${XSD}date`, language: null };
  claim.sources = Array.from({ length: 40 }, (_, index) => id(600 + index));
  expect(await readCollectionPurpose(run.session(), run.collection)).toBeNull();
  expect(run.citationReads).toEqual([]);
});

test('manual native assertion sources survive without a converter or retained-evidence registration', async () => {
  const run = fixture(), claim = run.add('reading-list', run.collection, ['https://example.org/curator-note']);
  expect((await run.direct(run.session())).items[0]?.collectionPurpose).toEqual({ kind: 'reading-list',
    statement: claim.statement, revision: claim.revision, sources: ['https://example.org/curator-note'] });
});

test('final selection fences recheck current adoption, Statement revision, value and readability', async () => {
  for (const move of ['reject', 'revision', 'value', 'hidden'] as const) {
    const run = fixture(), claim = run.add('series'), read = run.session();
    await readCollectionPurpose(read, run.collection);
    if (move === 'reject') claim.acceptance = 'rejected';
    if (move === 'revision') claim.revision = id(999);
    if (move === 'value') claim.value = { kind: 'literal', lexical: 'franchise', datatype: `${XSD}string`, language: null };
    if (move === 'hidden') run.hidden.add(claim.statement);
    await expect(read.fenceDependencies()).rejects.toThrow();
  }
});

test('Collection owner admission is current and does not manufacture a generic Work target', async () => {
  const run = fixture(), read = run.session();
  run.add('series');
  expect(await readCollectionPurpose(read, run.collection)).toMatchObject({ kind: 'series' });
  expect(run.queries.some(query => query.includes('SELECT ?component ?profile ?head ?generation ?count ?manifest'))).toBe(true);
  expect(run.queries.some(query => query.includes('SELECT ?epoch ?sequence ?r ?revision'))).toBe(false);
  run.retireCollection();
  await expect(read.fenceDependencies()).rejects.toThrow();
  await expect(readCollectionPurpose(run.session(), run.collection)).rejects.toThrow('Collection Structure is unavailable');
});

test('collection relation continuation is selection bound and preserves incidence without creating repeated membership records', async () => {
  const run = fixture(); run.collections.push(id(11), id(12));
  const original = [...run.collections];
  run.add('reading-list', id(11)); run.add('recipe-selection', id(12));
  const first = await run.direct(run.session(), 1);
  expect(first.items.map(item => item.relation)).toEqual([run.collection]);
  const second = await run.direct(run.session(), 1, first.next!);
  const third = await run.direct(run.session(), 1, second.next!);
  expect([...first.items, ...second.items, ...third.items].map(item => item.relation)).toEqual(original);
  expect(third.next).toBeNull();
  await expect(run.direct(run.session(), 2, first.next!)).rejects.toThrow('cursor is invalid');
  expect(run.collections).toEqual(original);
  expect(run.queries.some(query => /INSERT|DELETE/u.test(query))).toBe(false);
});

test('purpose adoption leaves repeated canonical membership identities, ordering and continuation intact', async () => {
  const run = fixture(), membership = await run.membership();
  const first = await membership.read();
  expect(first.occurrences).toEqual([membership.records[0]!]);
  expect(first.next).not.toBeNull();
  const claim = run.add('series');
  const adopted = (await run.direct(run.session())).items[0]!;
  expect(adopted.collectionPurpose?.statement).toBe(claim.statement);
  const sameFirst = await membership.read(), second = await membership.read(first.next!),
    third = await membership.read(second.next!);
  expect(sameFirst).toEqual(first);
  expect([...first.occurrences, ...second.occurrences, ...third.occurrences]).toEqual(membership.records);
  expect(new Set(membership.records.map(row => row.occurrence)).size).toBe(3);
  expect(membership.records.map(row => row.target)).toEqual([run.member, run.member, run.member]);
  expect(third.next).toBeNull();
  claim.acceptance = 'withdrawn';
  expect((await run.direct(run.session())).items[0]?.collectionPurpose).toBeNull();
  expect(await membership.read(first.next!)).toEqual(second);
});

test('direct and embedded relation readers return the same adopted purpose and structural rendering', async () => {
  const run = fixture(); run.add('franchise');
  const direct = await run.direct(run.session());
  const embedded = await readPageRelations(run.session(), run.member);
  expect(embedded.items.map(item => [item.collectionPurpose, item.rendering]))
    .toEqual(direct.items.map(item => [item.collectionPurpose, item.rendering]));
});

test('the public subject Statement owner reads the exact Collection assertion through its canonical Structure', async () => {
  const run = fixture(), claim = run.add('recipe-selection', run.collection, ['https://example.org/selection']);
  const relations = await run.direct(run.session());
  const facts = await readSubjectStatements(run.session(), run.collection);
  const statement = facts.groups.flatMap(group => group.items).find(item => item.kind === 'statement');
  expect(statement).toMatchObject({ statement: claim.statement, revision: claim.revision, sources: claim.sources,
    acceptance: { context: GLOBAL_CLASSIFICATION_CONTEXT } });
  expect(relations.items[0]?.collectionPurpose).toMatchObject({ statement: claim.statement, revision: claim.revision,
    sources: statement?.sources });
  expect(run.queries.some(query => query.includes('SELECT ?component ?profile ?head ?generation ?count ?manifest'))).toBe(true);
  run.hidden.add(run.collection);
  await expect(readSubjectStatements(run.session(), run.collection)).rejects.toThrow('Collection is unavailable');
});

test('collection rendering declares Structure provenance and the exact finite nullable purpose contract', () => {
  const headings = ['Collections', 'Reading lists', 'Recipe selections', 'Series', 'Franchises'];
  for (const [index, kind] of [null, ...COLLECTION_PURPOSE_KINDS].entries()) {
    const purpose = kind === null ? null : { kind, statement: id(7), revision: id(8), sources: [] };
    const rendering = renderCollectionIncidence(id(10), id(1), purpose, ['en']);
    expect(rendering.meaning).toBeNull();
    expect(rendering.structuralBasis).toEqual({ profile: 'collection-membership', collection: id(10), member: id(1) });
    expect(rendering.projections[0]?.labels?.heading).toBe(headings[index]);
    const entry = { relation: id(10), kind: 'collection', revision: null, evidence: null, rendering,
      collectionPurpose: purpose, counterparts: [] };
    expect(Value.Check(resourceRelationEntry, entry)).toBe(true);
    expect(Value.Check(resourceRelationEntry, { ...entry, collectionPurpose: { ...purpose, kind: 'ordinary' } })).toBe(false);
    expect(Value.Check(resourceRelationEntry, { ...entry, collectionPurpose: { ...purpose, conversion: id(9) } })).toBe(false);
  }
});

test('fixed incidence labels retain their recorded language and truthful script fallback', () => {
  const purpose = { kind: 'reading-list' as const, statement: id(7), revision: id(8), sources: [] };
  const preferred = renderCollectionIncidence(id(10), id(1), purpose, ['en']).projections[0]!;
  expect(preferred).toMatchObject({ language: 'en', script: 'Latn', direction: 'ltr', fallback: null,
    labels: { heading: 'Reading lists' } });
  const translated = renderCollectionIncidence(id(10), id(1), purpose, ['zh-Hant']).projections[0]!;
  expect(translated).toMatchObject({ language: 'en', script: 'Latn', direction: 'ltr',
    fallback: { reason: 'script-fallback', requestedLanguages: ['zh-Hant'], usedLanguage: 'en',
      requestedScript: 'Hant', usedScript: 'Latn', crossedScript: true, conversion: null } });
  const absent = renderCollectionIncidence(id(10), id(1), null, []).projections[0]!;
  expect(absent).toMatchObject({ language: 'en', labels: { heading: 'Collections' },
    fallback: { requestedLanguages: [], requestedScript: null, usedLanguage: 'en', crossedScript: false } });
});
