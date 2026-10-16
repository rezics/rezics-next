import { expect, test } from 'bun:test';
import { readRankedCatalogue, RANKED_CATALOGUE_COST } from '../src/modules/search/ranked.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { InvalidSearchContinuation, SearchContinuationRestart } from '../src/modules/work/search-continuation.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { PublicTextPosition } from '../src/modules/work/search-readiness.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { PublicRealmUnavailable } from '../src/modules/work/search-public.ts';
import { RV } from '../src/modules/work/activate.ts';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { boundedSearchHydration, SEARCH_HYDRATION_FENCE_MS } from '../src/modules/search/hydration.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const b = (value: string) => ({ type: 'literal', value });
const position: PublicTextPosition = { dataEpoch: 'epoch', sequence: '9',
  generation: 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111',
  population: 20_005, serverInstanceId: '11111111-1111-4111-8111-111111111111', publicSearchWriteEpoch: '0' };

function fixture(count = 2005) {
  const calls: string[] = [];
  const realmState = { closed: false, checks: 0, afterCheck: () => {} };
  const hits = Array.from({ length: count }, (_, n) => ({ id: `urn:rezics:g556:unit:${n}`, key: id(n), score: '1.0' }));
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (query: string, bytes: number) => {
      calls.push(query);
      expect(bytes).toBeLessThanOrEqual(RANKED_CATALOGUE_COST.responseBytes);
      if (query.includes('SELECT ?space ?realmRevision')) return { results: { bindings: [{
        space: b(id(9000)), realmRevision: b(id(9002)), disclosure: b(`${RV}Public`),
        visibility: b('public'), mode: b('open'),
      }] } };
      if (query.includes('SELECT ?work ?head ?owningWork')) return { results: { bindings: [{
        work: b(id(9001)), head: b(id(9002)),
      }] } };
      if (query.includes('SELECT ?space')) return { results: { bindings: [{ space: b(id(9000)) }] } };
      if (query.includes('rv:rankedText')) {
        const args = /rv:rankedText\(rv:searchBody, "(?:[^"\\]|\\.)*", (\d+), ("(?:[^"\\]|\\.)*"),/u.exec(query)!;
        expect(args).not.toBeNull();
        const size = Number(args[1]), cursor = JSON.parse(args[2]!) as string;
        const after = cursor ? JSON.parse(cursor) as { id: string } : null;
        const offset = after ? hits.findIndex(hit => hit.id === after.id) + 1 : 0;
        const selected = hits.slice(offset, offset + size);
        const current = searchGraphSnapshot.getStore()!.position;
        return { results: { bindings: [{ epoch: b(current.dataEpoch), sequence: b(current.sequence), generation: b(current.generation),
          page: b(JSON.stringify({ hits: selected, count: Math.min(count, 1000),
            precision: count > 1000 ? 'lower-bound' : 'exact', commit: '7', more: offset + size < count })) }] } };
      }
      const units = [...query.matchAll(/<(urn:rezics:g556:unit:\d+)>/gu)].map(match => match[1]!);
      return { results: { bindings: units.map(unit => {
        const hit = hits.find(hit => hit.id === unit)!;
        return { unit: b(unit), work: b(hit.key), main: b(hit.key), contribution: b(id(8000)),
          revision: b(id(8001)), selection: b(id(8002)), language: b('en') };
      }) } };
    },
  } } as unknown as WorkActivationEnvironment;
  configureDisclosure(env, { read: async targets => {
    realmState.checks++;
    const decisions = targets.map(() => realmState.closed ? 'hidden' as const : 'visible' as const);
    realmState.afterCheck();
    return decisions;
  } });
  const read = <T>(fn: () => Promise<T>, selectedPosition = position) => searchGraphSnapshot.run({
    clients: new Set([env.fuseki]), lineage: env.lineage, position: selectedPosition }, fn);
  return { env, read, calls, realmState };
}
const request = { phrase: 'common catalogue phrase', language: null, pageSize: 20 } as const;

test('cancelled Realm hydration withholds scope, counts and continuation when the Realm closes', async () => {
  const { env, read, realmState } = fixture(100);
  const selected = { ...request, realm: id(9001) };
  const first = await read(() => readRankedCatalogue(env, selected));
  for (const continuation of [undefined, first.next!]) {
    for (const duringFence of [false, true]) {
      realmState.closed = false;
      realmState.afterCheck = () => { if (duringFence) realmState.closed = true; };
      await expect(read(() => readRankedCatalogue(env, { ...selected, continuation },
        undefined, async () => { realmState.closed = !duringFence; return null; })))
        .rejects.toBeInstanceOf(PublicRealmUnavailable);
    }
  }
});

test('G-556: catalogue >20,000 and phrase >2,000 traverse 200 ranked Works without gaps or duplicates', async () => {
  const { env, read, calls } = fixture();
  let continuation: string | undefined;
  const traversed: string[] = [];
  for (let n = 0; n < 10; n++) {
    const before = calls.length;
    const page = await read(() => readRankedCatalogue(env, { ...request, continuation }));
    expect(page.population).toBe(20_005);
    expect(page.results).toHaveLength(20);
    expect(page.count).toEqual({ value: (n + 1) * 20, precision: 'lower-bound' });
    expect(calls.length - before).toBe(2);
    expect(page.next).not.toBeNull();
    continuation = page.next!;
    traversed.push(...page.results.map(row => row.work));
  }
  expect(traversed).toEqual(Array.from({ length: 200 }, (_, n) => id(n)));
  expect(new Set(traversed).size).toBe(200);
});

test('G-556: filtered candidates refill from the next ranks and preserve the first unconsumed rank', async () => {
  const { env, read } = fixture(100);
  const filter = async (rows: Awaited<ReturnType<typeof readRankedCatalogue>>['results']) =>
    rows.filter(row => Number(row.work.slice(-12)) % 2 === 1);
  const first = await read(() => readRankedCatalogue(env, request, filter));
  const again = await read(() => readRankedCatalogue(env, request, filter));
  expect(first.results).toEqual(again.results);
  const second = await read(() => readRankedCatalogue(env, { ...request, continuation: first.next! }, filter));
  expect([...first.results, ...second.results].map(row => row.work))
    .toEqual(Array.from({ length: 40 }, (_, n) => id(2 * n + 1)));
  const last = await read(() => readRankedCatalogue(env, { ...request, continuation: second.next! }, filter));
  expect(last.count).toEqual({ value: 50, precision: 'exact' });
  expect(last.next).toBeNull();
});

test('G-556: a sparse page keeps a continuation when its refill budget is exhausted', async () => {
  const { env, read, calls } = fixture();
  const page = await read(() => readRankedCatalogue(env, request, async () => []));
  expect(page.results).toEqual([]);
  expect(page.next).not.toBeNull();
  expect(page.count.precision).toBe('lower-bound');
  expect(calls).toHaveLength(2 * RANKED_CATALOGUE_COST.rankReads);
});

test('G-556: Realm rank reads restrict the native scope and page join to actual adoptions', async () => {
  const { env, read, calls } = fixture(100);
  const realm = id(9001);
  const page = await read(() => readRankedCatalogue(env, { ...request, realm }));
  expect(page.results).toHaveLength(20);
  expect(page.context).toEqual({ kind: 'realm-local', id: realm });
  expect(page.results.every(row => row.reason === 'realm-adoption')).toBe(true);
  expect(calls).toHaveLength(3);
  expect(calls[1]).toContain('\\"realm\\"');
  expect(calls[2]).toContain('a rv:RealmPublicationSlot');
  expect(calls[2]).toContain(`rv:realm <${realm}>`);
});

test('G-556: retained ranks survive writes; epoch and instance changes restart; a changed query is invalid', async () => {
  const { env, read } = fixture();
  const page = await read(() => readRankedCatalogue(env, request));
  for (const changed of [{ ...position, sequence: '10' }, { ...position,
    generation: 'urn:rezics:text-index-generation:22222222-2222-4222-8222-222222222222' },
    { ...position, publicSearchWriteEpoch: '2' }]) {
    const continued = await read(() => readRankedCatalogue(env, { ...request, continuation: page.next! }), changed);
    expect(continued.results.map(row => row.work)).toEqual(Array.from({ length: 20 }, (_, n) => id(n + 20)));
    expect(continued.indexGeneration).toBe(page.indexGeneration);
  }
  for (const changed of [{ ...position, dataEpoch: 'restored-epoch' }, { ...position, serverInstanceId: 'new-process' }]) {
    await expect(read(() => readRankedCatalogue(env, { ...request, continuation: page.next! }), changed))
      .rejects.toBeInstanceOf(SearchContinuationRestart);
  }
  await expect(read(() => readRankedCatalogue(env, { ...request, phrase: 'different phrase', continuation: page.next! })))
    .rejects.toBeInstanceOf(InvalidSearchContinuation);
});

test('current presentation filtering advances through the retained ranking without expiring its cursor', async () => {
  const { env, read } = fixture(100);
  const first = await read(() => readRankedCatalogue(env, request));
  const continued = await read(() => readRankedCatalogue(env, { ...request, continuation: first.next! },
    async rows => rows.filter(row => Number(row.work.slice(-12)) >= 30)));
  expect(continued.results.map(row => row.work)).toEqual(Array.from({ length: 20 }, (_, n) => id(n + 30)));
  expect(new Set([...first.results, ...continued.results].map(row => row.work)).size).toBe(40);
});

for (const realm of [undefined, id(9001)]) {
  test(`deferred ${realm ? 'Realm' : 'global'} catalogue hydration preserves first, middle and terminal pages without a basis change`, async () => {
    const { env, read, realmState } = fixture(45);
    let continuation: string | undefined;
    const works: string[] = [];
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const selected = { ...request, realm, continuation };
      const deferred = await fusekiReadBudget.run({ signal: new AbortController().signal,
        callsLeft: 72, bytesLeft: 8_388_608, deadline: performance.now() + SEARCH_HYDRATION_FENCE_MS - 1 },
        () => read(() => readRankedCatalogue(env, selected, undefined,
          () => boundedSearchHydration(async () => { throw new Error('No card allocation remains'); }))));
      expect(deferred.results).toEqual([]);
      expect(deferred.count).toEqual({ value: works.length, precision: 'lower-bound' });
      expect(deferred.next).not.toBeNull();
      expect(deferred.sourcePosition).toEqual({ datasetId: 'product', dataEpoch: position.dataEpoch, sequence: position.sequence });
      expect(deferred.indexGeneration).toBe(position.generation);
      const page = await read(() => readRankedCatalogue(env, { ...selected, continuation: deferred.next! }));
      works.push(...page.results.map(row => row.work));
      expect(page.count).toEqual({ value: works.length, precision: pageNumber === 2 ? 'exact' : 'lower-bound' });
      continuation = page.next ?? undefined;
    }
    expect(continuation).toBeUndefined();
    expect(works).toEqual(Array.from({ length: 45 }, (_, n) => id(n)));
    expect(realmState.checks).toBe(realm ? 6 : 0);
  });
}
