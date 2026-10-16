import { expect, test } from 'bun:test';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { readPublicTypeahead } from '../src/modules/search/typeahead.ts';
import { withStableSearchSnapshot } from '../src/modules/work/search-readiness.ts';
import { prefixWalkCursor, prefixWalkDirectoryKey,
  type PrefixWalkEntry, type PrefixWalkRequest, type PrefixWalkResponse } from '../src/modules/search/prefix-walk.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const value = (text: string) => ({ type: 'literal' as const, value: text });
const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-000000000001';
type Row = NonNullable<SparqlResult['results']>['bindings'][number];

function nativeEntry(number: number, matchedField: 'title' | 'credit' = 'title', rejected = false): PrefixWalkEntry {
  const entry = { mainVersion: id(number), matchUnit: id(number + 1_000), matchedField, rejected };
  return { ...entry, key: prefixWalkDirectoryKey(entry) };
}
function candidate(entry: PrefixWalkEntry, text = 'Bounded title'): Row {
  return { unit: value(entry.matchUnit), main: value(entry.mainVersion), work: value(id(Number.parseInt(entry.mainVersion.slice(-12), 16) + 2_000)),
    head: value(id(4_001)), contribution: value(id(3_001)), revision: value(id(3_002)), selection: value(id(3_003)),
    language: value('en'), field: value(entry.matchedField), kind: value('label'),
    text: { ...value(text), 'xml:lang': 'en' } };
}

function fixture(entries: PrefixWalkEntry[], rows = entries.filter(entry => !entry.rejected).map(entry => candidate(entry))) {
  const queries: string[] = [], walks: PrefixWalkRequest[] = [];
  const state = { available: true, failure: null as Error | null, sequence: '7', summaryReads: 0,
    hidden: new Set<string>(), changeNameOnSecondRead: false, writeEpoch: '0', nativeGeneration: '1' };
  const control = () => ({ epoch: value('epoch'), sequence: value(state.sequence), generation: value(generation), population: value('256') });
  const fuseki = {
    commandHealth: async () => ({ moduleVersion: 'test', instanceId: '00000000-0000-4000-8000-000000000001',
      publicSearchWriteEpoch: state.writeEpoch, publicSearchWriteActive: false, publicSearchDeltaAvailable: false,
      prefixWalkAvailable: state.available, profiles: {} }),
    prefixWalk: async (request: PrefixWalkRequest): Promise<PrefixWalkResponse> => {
      walks.push(request);
      if (state.failure) throw state.failure;
      const after = request.cursor === null ? '' : (JSON.parse(Buffer.from(request.cursor, 'base64url').toString()) as { after: string }).after;
      const remaining = entries.filter(entry => entry.key.localeCompare(after) > 0);
      const page = remaining.slice(0, request.pageSize);
      const more = remaining.length > page.length;
      return { entries: page, generation: state.nativeGeneration, examined: page.length,
        rejected: page.filter(entry => entry.rejected).length, more,
        cursor: more ? prefixWalkCursor(request, state.nativeGeneration, page.at(-1)!.key) : null };
    },
    query: async (sparql: string) => {
      queries.push(sparql);
      let bindings: Row[];
      if (sparql.includes('SELECT ?unit ?work')) {
        bindings = rows.filter(row => sparql.includes(`<${row.unit!.value}>`)).reverse();
      } else if (sparql.includes('SELECT DISTINCT ?work ?field')) {
        bindings = rows.filter(row => sparql.includes(`<${row.work!.value}>`)).reverse();
      } else if (sparql.includes('SELECT ?epoch ?sequence ?work ?type')) {
        bindings = rows.filter(row => sparql.includes(`<${row.work!.value}>`))
          .map(row => ({ ...control(), work: row.work! }));
      } else if (sparql.includes('SELECT ?resource ?head')) {
        bindings = [...new Map(rows.filter(row => sparql.includes(`<${row.work!.value}>`))
          .map(row => [row.work!.value, { resource: row.work!, head: value(id(4_001)) }])).values()];
      } else if (sparql.includes('SELECT ?work ?head ?type')) {
        bindings = rows.filter(row => sparql.includes(`<${row.work!.value}>`))
          .map(row => ({ work: row.work!, head: value(id(4_001)) }));
      } else if (sparql.includes('SELECT ?epoch ?sequence ?hold ?r ?type')) {
        state.summaryReads++;
        bindings = rows.filter(row => sparql.includes(`<${row.work!.value}>`)).map(row => ({
          ...control(), r: row.work!, work: row.work!, type: value('work'), head: value(id(4_001)),
          public: value(state.hidden.has(row.work!.value) ? 'false' : 'true'), erased: value('false'),
          label: { ...value(state.changeNameOnSecondRead && state.summaryReads > 1 ? 'Changed name' : 'Bounded title'), 'xml:lang': 'en' },
        }));
        if (!bindings.length) bindings = [control()];
      } else if (/SELECT \?epoch \?sequence(?: \?generation)?(?: \?population)? WHERE/u.test(sparql)) {
        bindings = [control()];
      } else bindings = [];
      return { results: { bindings } };
    },
  };
  const env = { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } as unknown as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(env, target => target.work
    ? { resource: target.work, head: id(4_001), protectedRevision: target.workRevision } : undefined);
  configureDisclosure(env, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  const work = { environment: env, access: { assertRecoveryOpen: async () => undefined,
    canReadWorks: async () => new Set<string>() } } as unknown as MainWorkDependencies;
  return { env, work, state, queries, walks, fuseki };
}
const request = () => new Request('http://main.test/v1/search/typeahead?prefix=bounded');
const present: Parameters<typeof readPublicTypeahead>[3] = async relation => relation;

test('a withheld matching name replaced by a public matching credit during hydration replays admission', async () => {
  const entry = nativeEntry(1, 'credit'), row = candidate(entry, 'Bounded withheld credit');
  const withheld = id(7_001), publicAgent = id(7_002);
  row.agent = value(withheld);
  const f = fixture([entry], [row]);
  configureDisclosure(f.env, fixtureDisclosureReader(async targets => targets.map(target =>
    target.nameOwner === withheld ? 'hidden' : 'visible')));
  const original = f.fuseki.query;
  let replaced = false;
  f.fuseki.query = async query => {
    const result = await original(query);
    if (query.includes('SELECT ?epoch ?sequence WHERE') && f.walks.length === 1 && !replaced) {
      replaced = true; row.agent = value(publicAgent); row.text = value('Bounded public credit');
      f.state.sequence = '8';
    }
    return result;
  };
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present);
  expect(replaced).toBe(true);
  expect(page.items).toMatchObject([{ work: row.work!.value, matchedText: 'Bounded public credit' }]);
  expect(page.sourcePosition.sequence).toBe('8');
  expect(f.walks).toHaveLength(3);
});

function nativeAuthorFixture() {
  const entry = nativeEntry(1), row = candidate(entry), f = fixture([entry], [row]);
  const agent = id(7_000), credit = id(7_100), original = f.fuseki.query;
  let publicName = false;
  f.work.personPreferences = { visibleNameOwners: async () => new Set(publicName ? [agent] : []) } as never;
  f.fuseki.query = async query => {
    if (query.includes('SELECT ?work ?id ?key ?ordinal ?agent')) return { results: { bindings: [{
      work: row.work!, id: value(credit), agent: value(agent), role: value('author'),
    }] } };
    if (query.includes('SELECT ?agent ?displayName ?handle')) return { results: { bindings: [{
      agent: value(agent), displayName: value('Healthy native author'),
    }] } };
    return original(query);
  };
  return { ...f, row, agent, credit, publishName: () => { publicName = true; } };
}

test('published typeahead summaries and authors close once after hydration', async () => {
  const f = nativeAuthorFixture(), original = f.fuseki.query;
  f.publishName();
  // The closure outcome timed out after 26 graph calls. Bound repeated input
  // reads directly so host scheduling cannot make this regression flaky.
  const reads = new Map<string, number>();
  f.fuseki.query = async query => {
    reads.set(query, (reads.get(query) ?? 0) + 1);
    return original(query);
  };
  const page = await withStableSearchSnapshot(f.env.fuseki,
    () => readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present));
  expect(page.items).toMatchObject([{ work: f.row.work!.value,
    title: { value: 'Bounded title' }, authors: [{ agent: f.agent, displayName: 'Healthy native author' }] }]);
  expect(f.walks).toHaveLength(2);
  for (const [query, count] of reads) {
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r ?type')
      || query.includes('SELECT ?work ?id ?key ?ordinal ?agent')
      || query.includes('SELECT ?agent ?displayName ?handle')) {
      expect(count, query).toBeLessThanOrEqual(2);
    }
  }
});

test('a withheld native author becoming public before delivery replays authors and includes the name', async () => {
  const f = nativeAuthorFixture(), original = f.fuseki.query;
  let changed = false;
  f.fuseki.query = async query => {
    const result = await original(query);
    if (f.state.summaryReads === 2 && !changed) {
      changed = true; f.publishName(); f.state.sequence = '8';
    }
    return result;
  };
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present);
  expect(page.items[0]?.authors).toMatchObject([{ agent: f.agent, displayName: 'Healthy native author' }]);
  expect(page.sourcePosition.sequence).toBe('8');
  expect(f.walks).toHaveLength(3);
});

test('a failing source-binding lookup retains healthy native authors', async () => {
  const f = nativeAuthorFixture();
  f.publishName();
  let sourceReads = 0;
  f.work.sourceAdoptions = { authorReferences: async () => {
    sourceReads++; throw new Error('source binding owner unavailable');
  } } as never;
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present);
  expect(sourceReads).toBeGreaterThan(0);
  expect(page.items[0]?.authors).toMatchObject([{ agent: f.agent, displayName: 'Healthy native author' }]);
  expect(f.walks).toHaveLength(2);
});

test('hydration spans the examined cap once and returns only the first ten accepted entries in walk order', async () => {
  const entries = Array.from({ length: 50 }, (_, index) => nativeEntry(index + 1));
  const f = fixture(entries);
  let selections = 0;
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, async relation => {
    selections++; return relation;
  });
  expect(selections).toBe(2); // Opening selection and its whole-read replay.
  expect(f.walks).toHaveLength(8);
  expect(f.walks.every(walk => walk.pageSize === 10)).toBe(true);
  expect(page.items.map(item => item.mainVersion)).toEqual(entries.slice(0, 10).map(entry => entry.mainVersion));
  expect(page.hasMore).toBe(true);
  expect(f.queries.filter(query => query.includes('SELECT ?unit ?work'))).toHaveLength(2);
});

test('a terminal hydrated tail after the tenth accepted entry still reports continuation', async () => {
  const entries = Array.from({ length: 11 }, (_, index) => nativeEntry(index + 1));
  const f = fixture(entries);
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present);
  expect(page.items).toHaveLength(10);
  expect(page.hasMore).toBe(true);
});
