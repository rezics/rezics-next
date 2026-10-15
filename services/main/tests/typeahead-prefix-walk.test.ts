import { expect, test } from 'bun:test';
import { foregroundCounted } from '../../../tests/qa/integration/support/operation-cost.ts';
import { FusekiClient, FusekiPrefixWalkRestart, FusekiPrefixWalkUnavailable, FusekiReadBudgetExceeded,
  createFusekiReadDiagnostics, fusekiReadBudget, snapshotFusekiReadDiagnostics,
  type SparqlResult, type FusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { discloseTypeaheadMatches, queryTypeaheadCandidates, readPublicTypeahead } from '../src/modules/search/typeahead.ts';
import { prefixWalkCursor, prefixWalkDirectoryKey, prefixWalkExaminedLimit,
  type PrefixWalkEntry, type PrefixWalkRequest, type PrefixWalkResponse } from '../src/modules/search/prefix-walk.ts';
import { SEARCH_FIELD_COST, type FieldMatch } from '../src/modules/search/fields.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { SourceAuthorNameStore } from '../src/modules/source/author-name.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { PublicQueryUnavailable } from '../src/modules/work/search-budget.ts';
import { SearchSnapshotMoved, withStableSearchSnapshot } from '../src/modules/work/search-readiness.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { WORK_READ_COST } from '../src/modules/work/read-contract.ts';
import { searchRoutes } from '../src/routes/search.ts';
import { configureDisclosure, configureDisclosureAncestrySource, type DisclosureAncestryEvidence,
  type DisclosureTarget } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { createHash } from 'node:crypto';

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

test('typeahead resolves placed Work ancestry before capture, preserving order in bounded open and closed Realm batches', async () => {
  const f = fixture([]), realm = id(9_000), realmHead = id(9_001), workHead = id(4_001);
  const selected = new Map<string, DisclosureTarget>(), batches: number[] = [];
  let closed = false, incomplete = false, parentQueries = 0;
  const establish = (target: DisclosureTarget): DisclosureAncestryEvidence => {
    const token = createHash('sha256').update(JSON.stringify(target)).digest('hex'); selected.set(token, target);
    const relationshipBasis = { owner: 'graph' as const, kind: 'work-in-realm' as const,
      resource: target.resource, revision: target.revision!, targetResource: target.resource,
      targetRevision: target.revision ?? null, token, dataEpoch: 'epoch' };
    return { resource: target.resource, resourceKind: 'work', status: 'complete', relationshipBasis,
      parents: incomplete ? [] : [
        { owner: 'graph', kind: 'work', resource: target.resource, head: workHead,
          protectedRevision: target.workRevision, relationshipBasis },
        { owner: 'graph', kind: 'realm', resource: realm, head: realmHead, relationshipBasis },
      ] };
  };
  configureDisclosureAncestrySource(f.env, 'graph', { read: async targets => {
    batches.push(targets.length); return targets.map(establish);
  }, reread: async bases => bases.map(basis => establish(selected.get(basis.token)!)) });
  configureDisclosure(f.env, fixtureDisclosureReader(async targets => targets.map(target =>
    closed && target.ancestry!.parents.some(parent => parent.resource === realm) ? 'hidden' : 'visible')));
  f.fuseki.query = async query => {
    expect(query).toContain('SELECT ?resource ?head'); parentQueries++;
    const refs = [...query.match(/VALUES \?resource \{([^}]+)\}/)![1]!.matchAll(/<([^>]+)>/g)].map(match => match[1]!);
    return { results: { bindings: refs.map(resource => ({ resource: value(resource),
      head: value(resource === realm ? realmHead : workHead) })) } };
  };
  const matches: FieldMatch[] = Array.from({ length: 65 }, (_, n) => ({ work: id(10_000 + Math.floor(n / 2)),
    mainVersion: id(11_000 + n), matchUnit: id(12_000 + n), contribution: id(13_000 + n),
    revision: id(14_000 + n), selection: id(15_000 + n), language: 'en', score: 1,
    matchedField: 'title', matchedText: `Selected ${n}`, matchedLanguage: 'en' }));
  const heads = new Map(matches.map(match => [match.work, workHead]));
  expect(await discloseTypeaheadMatches(f.env, matches, heads)).toEqual(matches);
  expect(batches).toEqual([64, 1]); expect(parentQueries).toBe(2);
  closed = true;
  expect(await discloseTypeaheadMatches(f.env, matches, heads)).toEqual([]);
  incomplete = true;
  await expect(discloseTypeaheadMatches(f.env, matches, heads)).rejects.toThrow('Disclosure ancestry is incomplete');
});

test('native prefix transport sends the command envelope and accounts visits, failures and byte limits', async () => {
  const capability = 'b'.repeat(64);
  const input: PrefixWalkRequest = { prefix: 'bounded', language: null, pageSize: 2, cursor: null };
  const entries = [nativeEntry(1, 'title', true), nativeEntry(2)];
  const native: PrefixWalkResponse = { entries, generation: '1', examined: 2, rejected: 1, more: false, cursor: null };
  const payload = JSON.stringify(native);
  let status = 200;
  const received: { method: string; path: string; authorization: string | null; envelope: unknown }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    received.push({ method: request.method, path: new URL(request.url).pathname,
      authorization: request.headers.get('authorization'), envelope: await request.json() });
    return new Response(status === 200 ? payload : '{}', { status,
      headers: { 'content-type': 'application/json' } });
  } });
  const controller = new AbortController();
  const budget: FusekiReadBudget = { signal: controller.signal, callsLeft: 4,
    bytesLeft: 65_536, diagnostics: createFusekiReadDiagnostics() };
  try {
    const client = new FusekiClient(`http://127.0.0.1:${server.port}/rezics/`, undefined, capability);
    const read = () => fusekiReadBudget.run(budget, () => client.prefixWalk(input));
    expect(await read()).toEqual(native);
    expect(received).toEqual([{ method: 'POST', path: '/rezics/command',
      authorization: `Bearer ${capability}`, envelope: { prefixWalk: input } }]);
    expect(budget.callsLeft).toBe(3);
    expect(budget.bytesLeft).toBe(65_536 - Buffer.byteLength(payload));
    expect(snapshotFusekiReadDiagnostics(budget)).toMatchObject({ active: [], omitted: 0,
      history: [{ family: 'query', examined: 2, status: 'complete' }] });
    status = 409;
    await expect(read()).rejects.toBeInstanceOf(FusekiPrefixWalkRestart);
    status = 503;
    await expect(read()).rejects.toBeInstanceOf(FusekiPrefixWalkUnavailable);
    expect(budget.callsLeft).toBe(1);
    expect(snapshotFusekiReadDiagnostics(budget)?.history.map(call => call.status))
      .toEqual(['complete', 'failed', 'failed']);
    status = 200;
    budget.bytesLeft = Buffer.byteLength(payload) - 1;
    await expect(read()).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    expect(budget.callsLeft).toBe(0);
    expect(received).toHaveLength(4);
    controller.abort(new Error('search deadline expired'));
    await expect(read()).rejects.toBe(controller.signal.reason);
    expect(received).toHaveLength(4);
  } finally { await server.stop(true); }
});

test('candidate hydration follows native title/credit ordering and contains only the walked units', async () => {
  const entries = [nativeEntry(2), nativeEntry(3), nativeEntry(1, 'credit')];
  const rows = [candidate(entries[0]!), candidate(entries[1]!, 'Bounded second'),
    { ...candidate(entries[2]!, 'Bounded native author'), agent: value(id(5_001)) }];
  const f = fixture(entries, rows);
  const matches = await queryTypeaheadCandidates(f.env, 'bounded', entries);
  expect(matches.map(row => [row.mainVersion, row.matchedField, row.matchedText]))
    .toEqual([[id(2), 'title', 'Bounded title'], [id(3), 'title', 'Bounded second'],
      [id(1), 'credit', 'Bounded native author']]);
  expect(matches[2]?.nameOwner).toBe(id(5_001));
  expect(f.queries).toHaveLength(3);
  const sparql = f.queries[0]!;
  expect(sparql).toContain('VALUES');
  for (const entry of entries) expect(sparql).toContain(`<${entry.matchUnit}>`);
  expect(f.queries.every(query => !/CONTAINS\s*\(/iu.test(query))).toBe(true);
});

test('source-author matches use bounded exact key hydration and preserve source text', async () => {
  const entry = nativeEntry(1, 'credit');
  const row: Row = { ...candidate(entry), key: value('/authors/OL1A'), kind: value('source') };
  delete row.text;
  const f = fixture([entry], [row]);
  const batches: string[][] = [];
  let searches = 0;
  const names = { batch: async (keys: string[]) => {
    batches.push(keys);
    return new Map([['/authors/OL1A', { displayName: 'Jane Bounded', nameSource: { revision: id(6_001) } }]]);
  }, search: async () => { searches++; throw new Error('typeahead must not search SQL names'); },
  searchGeneration: async () => '1' } as unknown as SourceAuthorNameStore;
  const matches = await queryTypeaheadCandidates(f.env, 'bounded', [entry], names);
  expect(matches).toMatchObject([{ matchedField: 'credit', matchedText: 'Jane Bounded', matchedLanguage: null }]);
  expect(batches).toEqual([['/authors/OL1A']]);
  expect(searches).toBe(0);
  expect(f.queries.every(sparql => !/CONTAINS\s*\(/iu.test(sparql))).toBe(true);
});

test('typeahead advances past native tombstones, hidden and presentation-rejected Works to fill its page', async () => {
  const entries = Array.from({ length: 14 }, (_, index) => nativeEntry(index + 1, 'title', index === 0));
  const f = fixture(entries);
  f.state.hidden.add(id(2_002));
  const filtered: Parameters<typeof readPublicTypeahead>[3] = async relation => ({ ...relation,
    results: relation.results.filter(row => row.mainVersion !== id(3)) });
  const result = await readPublicTypeahead(f.work, request(), { prefix: 'bounded', language: 'fr' }, filtered);
  expect(result.items.map(item => item.mainVersion)).toEqual(Array.from({ length: 10 }, (_, index) => id(index + 4)));
  expect(result.hasMore).toBe(true);
  expect(result.sourcePosition).toEqual({ dataEpoch: 'epoch', sequence: '7' });
  expect(f.walks.length).toBeGreaterThan(1);
  expect(f.walks[1]?.cursor).not.toBeNull();
  expect(f.walks.every(walk => walk.language === null && walk.pageSize <= SEARCH_FIELD_COST.typeaheadItems)).toBe(true);
  expect(f.walks.reduce((sum, walk) => sum + walk.pageSize, 0)).toBeLessThanOrEqual(2 * prefixWalkExaminedLimit(SEARCH_FIELD_COST.typeaheadItems));
  expect(f.queries.every(sparql => !/CONTAINS\s*\(/iu.test(sparql))).toBe(true);
});

test('terminal directory produces hasMore false and an exhausted rejection budget retains hasMore', async () => {
  const terminal = fixture([nativeEntry(1), nativeEntry(2)]);
  const result = await readPublicTypeahead(terminal.work, request(), { prefix: 'bounded' }, present);
  expect(result.items).toHaveLength(2);
  expect(result.hasMore).toBe(false);
  const limit = prefixWalkExaminedLimit(SEARCH_FIELD_COST.typeaheadItems);
  const rejected = fixture(Array.from({ length: limit + 1 }, (_, index) => nativeEntry(index + 1, 'title', true)));
  const empty = await readPublicTypeahead(rejected.work, request(), { prefix: 'bounded' }, present);
  expect(empty.items).toEqual([]);
  expect(empty.hasMore).toBe(true);
  expect(rejected.walks.reduce((sum, walk) => sum + walk.pageSize, 0)).toBe(2 * limit);
});

test('unadvertised and unqualified native directories refuse the route with typed 503 without a scan', async () => {
  for (const mode of ['unadvertised', 'unqualified'] as const) {
    const f = fixture([nativeEntry(1)]);
    if (mode === 'unadvertised') f.state.available = false;
    else f.state.failure = new FusekiPrefixWalkUnavailable('native generation has no qualified coverage');
    await expect(readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present))
      .rejects.toBeInstanceOf(PublicQueryUnavailable);
    const app = searchRoutes(f.env.fuseki, f.work);
    const response = await app.handle(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'query_unavailable' });
    if (mode === 'unadvertised') expect(f.walks).toEqual([]);
    expect(f.queries.every(sparql => !/CONTAINS\s*\(/iu.test(sparql))).toBe(true);
  }
});

test('native generation changes and changing hydrated disclosure refuse a partial page', async () => {
  const moved = fixture([nativeEntry(1)]);
  moved.state.failure = new FusekiPrefixWalkRestart('generation changed');
  await expect(readPublicTypeahead(moved.work, request(), { prefix: 'bounded' }, present))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  const changed = fixture([nativeEntry(1)]);
  changed.state.changeNameOnSecondRead = true;
  await expect(readPublicTypeahead(changed.work, new Request('http://main.test/typeahead'), { prefix: 'bounded' }, present))
    .rejects.toBeInstanceOf(SearchSnapshotMoved);
});

test('title-matched cards recheck their displayed source authors after hydration without a global source generation', async () => {
  const entry = nativeEntry(1), f = fixture([entry]);
  const selectedWork = candidate(entry).work!.value;
  let name = 'Selected author', renamed = false;
  f.work.sourceAdoptions = { authorReferences: async () => new Map([[selectedWork,
    [{ id: id(6_100), key: '/authors/OL1A', ordinal: 0 }]]]) } as never;
  f.work.sourceAuthorNames = { batch: async () => new Map([['/authors/OL1A', { displayName: name }]]) } as never;
  const original = f.fuseki.query;
  f.fuseki.query = async query => {
    const rows = await original(query);
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r') && f.state.summaryReads === 2 && !renamed) {
      renamed = true; name = 'Fresh selected author';
    }
    return rows;
  };
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present);
  expect(page.items[0]?.authors[0]?.displayName).toBe('Fresh selected author');
  expect(f.walks).toHaveLength(3);
});

test('unrelated native writer epochs and commit generations preserve an unchanged selected prefix traversal', async () => {
  const f = fixture([nativeEntry(1)]), original = f.fuseki.query;
  f.fuseki.query = async query => {
    const rows = await original(query);
    if (f.state.summaryReads === 2) {
      f.state.sequence = '39'; f.state.writeEpoch = '64'; f.state.nativeGeneration = '2';
    }
    return rows;
  };
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present);
  expect(page.items).toHaveLength(1); expect(page.sourcePosition.sequence).toBe('7');
  expect(f.walks).toHaveLength(2); // One native walk and its selected-relation fence, with no replay.
});

test('a new selected native prefix entry during hydration replays the bounded traversal', async () => {
  const entries = [nativeEntry(1)], rows = entries.map(entry => candidate(entry));
  const f = fixture(entries, rows), original = f.fuseki.query;
  let changed = false;
  f.fuseki.query = async query => {
    const counted = foregroundCounted();
    const result = await original(query);
    if (counted && f.state.summaryReads === 2 && !changed) {
      changed = true; entries.push(nativeEntry(2)); rows.push(candidate(entries[1]!));
      f.state.sequence = '8'; f.state.writeEpoch = '2'; f.state.nativeGeneration = '2';
    }
    return result;
  };
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present);
  expect(page.items).toHaveLength(2); expect(f.walks).toHaveLength(4);
  expect(page.sourcePosition.sequence).toBe('8');
});

test('terminal Work movement remains terminal inside the enclosing search retry envelope', async () => {
  const f = fixture([nativeEntry(1)]);
  f.state.failure = new FusekiPrefixWalkRestart('selected traversal changed');
  let enclosingAttempts = 0;
  await expect(withStableSearchSnapshot(undefined, async () => {
    enclosingAttempts++;
    return readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present);
  })).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(enclosingAttempts).toBe(1);
  expect(f.walks).toHaveLength(WORK_READ_COST.attempts);
});

test('an unshown muted candidate title edit does not replay the selected typeahead page', async () => {
  const entries = [nativeEntry(1), nativeEntry(2)], rows = entries.map(entry => candidate(entry));
  const f = fixture(entries, rows), original = f.fuseki.query;
  let changed = false;
  f.fuseki.query = async query => {
    const result = await original(query);
    if (f.state.summaryReads === 2 && !changed) {
      changed = true;
      rows[1]!.text = { ...value('Bounded edited muted title'), 'xml:lang': 'en' };
      f.state.sequence = '8';
    }
    return result;
  };
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, async relation => ({
    ...relation, results: relation.results.filter(row => row.work !== rows[1]!.work!.value),
  }));
  expect(page.items.map(item => item.work)).toEqual([rows[0]!.work!.value]);
  expect(page.sourcePosition.sequence).toBe('7');
  expect(f.walks).toHaveLength(2);
});

test('a duplicate MainVersion witness outside the shown typeahead cards does not fence its text', async () => {
  const title = nativeEntry(1), credit = nativeEntry(1, 'credit');
  credit.matchUnit = id(9_000); credit.key = prefixWalkDirectoryKey(credit);
  const entries = [title, ...Array.from({ length: 9 }, (_, index) => nativeEntry(index + 2, 'title', true)), credit];
  const rows = [candidate(title), candidate(credit, 'Bounded duplicate credit')];
  const f = fixture(entries, rows), original = f.fuseki.query;
  let changed = false;
  f.fuseki.query = async query => {
    const result = await original(query);
    if (f.walks.length === 2 && query.includes("SELECT ?epoch ?sequence WHERE") && !changed) {
      changed = true;
      rows[1]!.text = { ...value('Bounded edited duplicate credit'), 'xml:lang': 'en' };
      f.state.sequence = '8';
    }
    return result;
  };
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, present);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.matchedField).toBe('title');
  expect(page.sourcePosition.sequence).toBe('7');
  expect(f.walks).toHaveLength(4);
});

test('selection probes do not fence source names belonging only to muted typeahead candidates', async () => {
  const entries = [nativeEntry(1), nativeEntry(2, 'credit')], rows = entries.map(entry => candidate(entry));
  rows[1]!.kind = value('source'); rows[1]!.key = value('/authors/OL9000A');
  const f = fixture(entries, rows);
  let name = 'Bounded muted author', changed = false;
  f.work.sourceAuthorNames = { batch: async () => new Map([['/authors/OL9000A', {
    key: '/authors/OL9000A', displayName: name, language: 'en',
  }]]) } as unknown as SourceAuthorNameStore;
  const page = await readPublicTypeahead(f.work, request(), { prefix: 'bounded' }, async relation => {
    const selected = relation.results.filter(row => row.work !== rows[1]!.work!.value);
    if (!changed) { changed = true; name = 'Bounded changed muted author'; f.state.sequence = '8'; }
    return { ...relation, results: selected };
  });
  expect(page.items.map(item => item.work)).toEqual([rows[0]!.work!.value]);
  expect(page.sourcePosition.sequence).toBe('7');
  expect(f.walks).toHaveLength(2);
});
