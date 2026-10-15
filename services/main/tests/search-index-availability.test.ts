import { expect, test } from 'bun:test';
import { FusekiClient, fusekiReadBudget, type SearchDeltaProof } from '../src/infrastructure/fuseki.ts';
import { assertPublicTextReady, MAX_SEARCH_REQUEST_MS, SearchIndexUnavailable, SearchSnapshotMoved,
  SearchRequestTimedOut, withStableSearchSnapshot } from '../src/modules/work/search-readiness.ts';
import { readRankedCatalogue } from '../src/modules/search/ranked.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { withSearchGraphSnapshot } from '../src/modules/search/snapshot.ts';
import { searchOperationEvidence } from '../src/modules/search/operation-evidence.ts';

const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const term = (value: string) => ({ type: 'literal', value });

function indexed(sequence: string, epoch = lineage.dataEpoch) {
  const client = new FusekiClient('http://unused.invalid');
  let proofs = 0;
  client.commandHealth = async () => ({ moduleVersion: 'test', profiles: {},
    instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: '2', publicSearchWriteActive: false, publicSearchDeltaAvailable: true });
  client.query = async () => ({ results: { bindings: [{ epoch: term(lineage.dataEpoch),
    sequence: term('25'), generation: term(generation) }] } });
  client.searchDeltaSince = async (): Promise<SearchDeltaProof> => {
    proofs++;
    return { available: true, ordinal: '1', dataEpoch: epoch, sequence, generation,
      writeEpoch: '2', luceneGeneration: '3', qualifiedPopulation: '3', deltas: [] };
  };
  return { client, proofs: () => proofs };
}

test('ready public search consumes a checkpoint in the publication epoch and sequence', async () => {
  const fixture = indexed('25');
  expect(await assertPublicTextReady(fixture.client, lineage)).toMatchObject({
    dataEpoch: lineage.dataEpoch, sequence: '25', population: 3, generation });
  expect(fixture.proofs()).toBe(1);
});

test('a behind or foreign-epoch checkpoint refuses public membership without retry', async () => {
  for (const fixture of [indexed('24'), indexed('25', 'old-epoch')]) {
    await expect(withStableSearchSnapshot(fixture.client,
      () => assertPublicTextReady(fixture.client, lineage))).rejects.toBeInstanceOf(SearchIndexUnavailable);
    expect(fixture.proofs()).toBe(1);
  }
});

test.each(['2', '3', '5'])('a selected-unit search reads its published checkpoint while native writer epoch %s is observed', async writeEpoch => {
  const fixture = indexed('25');
  const health = await fixture.client.commandHealth();
  fixture.client.commandHealth = async () => ({ ...health,
    publicSearchWriteEpoch: '3', publicSearchWriteActive: true });
  const proof = fixture.client.searchDeltaSince.bind(fixture.client);
  fixture.client.searchDeltaSince = async (...args) => ({ ...await proof(...args), writeEpoch });
  const result = await withSearchGraphSnapshot(
    { fuseki: fixture.client, lineage, objectDirectory: '.temp/search-availability-owner' }, async () => {
      expect(searchGraphSnapshot.getStore()!.position.publicSearchWriteEpoch).toBe(writeEpoch);
      expect((await fixture.client.commandHealth()).publicSearchWriteActive).toBe(true);
      return { items: ['published-match'] };
    }, 'selected-units');
  expect(result).toEqual({ items: ['published-match'] });
  expect(fixture.proofs()).toBe(1);
  // Consumers without an exact selected relation retain their writer fence.
  await expect(assertPublicTextReady(fixture.client, lineage)).rejects.toBeInstanceOf(SearchSnapshotMoved);
});

test('selected-unit search never substitutes a stale or unqualified checkpoint for a published cut', async () => {
  for (const fixture of [indexed('24'), indexed('25', 'old-epoch')]) {
    const health = await fixture.client.commandHealth();
    fixture.client.commandHealth = async () => ({ ...health,
      publicSearchWriteEpoch: '3', publicSearchWriteActive: true });
    await expect(assertPublicTextReady(fixture.client, lineage, 'selected-units'))
      .rejects.toBeInstanceOf(SearchIndexUnavailable);
  }
});

test('a never-qualified native index refuses before selected-unit matching begins', async () => {
  const fixture = indexed('25');
  fixture.client.searchDeltaSince = async () => ({ available: false });
  let matched = false;
  await expect(withSearchGraphSnapshot(
    { fuseki: fixture.client, lineage, objectDirectory: '.temp/search-availability-owner' }, async () => {
      matched = true;
    }, 'selected-units')).rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(matched).toBe(false);
});

test('public search cancels unfinished work at its original wall bound without another attempt', async () => {
  let attempts = 0, cancelled = false;
  const started = performance.now();
  await expect(withStableSearchSnapshot(undefined, () => {
    attempts++;
    const budget = fusekiReadBudget.getStore()!;
    expect(budget.deadline! - performance.now()).toBeLessThanOrEqual(MAX_SEARCH_REQUEST_MS);
    return new Promise<never>((_resolve, reject) => {
      budget.signal.addEventListener('abort', () => { cancelled = true; reject(budget.signal.reason); }, { once: true });
    });
  })).rejects.toBeInstanceOf(SearchRequestTimedOut);
  expect(performance.now() - started).toBeGreaterThanOrEqual(MAX_SEARCH_REQUEST_MS - 10);
  expect(cancelled).toBe(true);
  expect(attempts).toBe(1);
});

test('one delivered catalogue slot admits only one initial index candidate to audience disclosure', async () => {
  const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const hits = Array.from({ length: 3 }, (_, n) => ({ id: `urn:rezics:unit:${n}`, key: id(n), score: '1' }));
  for (const population of [6, 22, 70]) {
    const client = new FusekiClient('http://unused.invalid');
    let candidates = 0;
    client.query = async sparql => {
      if (sparql.includes('rv:rankedText')) {
        const size = Number(/rv:rankedText\(rv:searchBody, "[^"]+", (\d+)/u.exec(sparql)![1]);
        return { results: { bindings: [{ epoch: term('epoch'), sequence: term('25'), generation: term(generation),
          page: term(JSON.stringify({ hits: hits.slice(0, size), commit: '7', more: size < hits.length })) }] } };
      }
      const units = [...sparql.matchAll(/<(urn:rezics:unit:\d+)>/gu)].map(match => match[1]!);
      return { results: { bindings: units.map(unit => ({ unit: term(unit), work: term(id(Number(unit.split(':').at(-1)))),
        main: term(id(Number(unit.split(':').at(-1)))), contribution: term(id(10)), revision: term(id(11)),
        selection: term(id(12)), language: term('en') })) } };
    };
    const env = { fuseki: client, lineage, objectDirectory: '.temp/search-availability-owner' };
    const position = { dataEpoch: lineage.dataEpoch, sequence: '25', generation, population,
      serverInstanceId: '11111111-1111-4111-8111-111111111111', publicSearchWriteEpoch: '2' };
    const page = await searchGraphSnapshot.run({ clients: new Set([client]), lineage, position },
      () => readRankedCatalogue(env, { phrase: 'needle story', language: null, pageSize: 1 }, async rows => {
        candidates += rows.length;
        return rows;
      }));
    expect(candidates).toBe(1);
    expect(page.results.map(row => row.work)).toEqual([id(0)]);
    expect(page.count).toEqual({ value: 1, precision: 'lower-bound' });
    expect(page.next).not.toBeNull();
  }
});

// These controls measure Main's submitted candidates and joins. They cannot
// measure the native function's term rewrites or prove its population cost.
test('ranked continuations keep Main candidate work bound to the page across unrelated growth', async () => {
  const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const expected = Array.from({ length: 3 }, (_, n) => ({ matchUnit: `urn:rezics:unit:${n}`, work: id(100 + n),
    mainVersion: id(n), contribution: id(200 + n), revision: id(300 + n), selection: id(400 + n), language: 'en' }));
  const hits = expected.map((row, document) => ({ id: `urn:rezics:search:name:work:${document}`,
    unit: row.matchUnit, key: row.mainVersion, score: '2000000', document }));
  const ranked = [...hits, { id: expected[0]!.matchUnit, key: null, score: '1', document: 3 }];
  for (const phrase of ['needle', 'needle story']) {
    for (const realm of [undefined, id(900)]) {
      let baseline: string[] | undefined;
      for (const population of [6, 22, 70, 196]) {
        const fixture = indexed('25'), client = fixture.client;
        const requests: string[] = [], submitted: number[] = [], disclosed: number[] = [];
        client.query = async sparql => {
          requests.push(sparql);
          if (sparql.includes('SELECT ?space')) return { results: { bindings: [{ space: term(id(901)) }] } };
          if (sparql.includes('rv:rankedText')) {
            const args = /rv:rankedText\(rv:searchBody, ("(?:[^"\\]|\\.)*"), (\d+), ("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*")\)/u.exec(sparql)!;
            expect(JSON.parse(args[1]!)).toBe(phrase);
            expect(JSON.parse(JSON.parse(args[4]!) as string)).toEqual({ catalogue: true, ...(realm ? { realm } : {}) });
            const after = JSON.parse(args[3]!) as string;
            const offset = after ? ranked.findIndex(hit => hit.id === (JSON.parse(after) as { id: string }).id) + 1 : 0;
            const size = Number(args[2]);
            expect(searchOperationEvidence.getStore()!.phases.filter(phase => phase.state === 'active').map(phase => phase.phase))
              .toContain('catalogue-native-rank-read');
            submitted.push(size);
            return { results: { bindings: [{ epoch: term('epoch'), sequence: term('25'), generation: term(generation),
              page: term(JSON.stringify({ hits: ranked.slice(offset, offset + size), commit: '7', more: offset + size < ranked.length })) }] } };
          }
          const values = /VALUES \?unit \{([^}]+)\}/u.exec(sparql)!;
          expect(searchOperationEvidence.getStore()!.phases.filter(phase => phase.state === 'active').map(phase => phase.phase))
            .toContain('catalogue-candidate-identity-read');
          const units = [...values[1]!.matchAll(/<(urn:rezics:unit:\d+)>/gu)].map(match => match[1]!);
          expect(units).toHaveLength(1);
          return { results: { bindings: expected.filter(row => units.includes(row.matchUnit)).map(row => ({
            unit: term(row.matchUnit), work: term(row.work), main: term(row.mainVersion), contribution: term(row.contribution),
            revision: term(row.revision), selection: term(row.selection), language: term(row.language),
          })) } };
        };
        const env = { fuseki: client, lineage, objectDirectory: '.temp/search-availability-owner' };
        const position = { dataEpoch: lineage.dataEpoch, sequence: '25', generation, population,
          serverInstanceId: '11111111-1111-4111-8111-111111111111', publicSearchWriteEpoch: '2' };
        let continuation: string | undefined;
        const delivered: typeof expected = [];
        await searchOperationEvidence.run({ phases: [] }, () => searchGraphSnapshot.run({ clients: new Set([client]), lineage, position }, async () => {
          for (let n = 0; n <= expected.length; n++) {
            const page = await readRankedCatalogue(env, { phrase, realm, language: null, pageSize: 1, continuation }, async rows => {
              disclosed.push(rows.length);
              return rows;
            });
            expect(page.results).toEqual(n === 3 ? [] : [{ ...expected[n], score: 2000000, ...(realm ? { reason: 'realm-adoption' } : {}) }]);
            delivered.push(...page.results);
            expect(page.count).toEqual({ value: delivered.length, precision: n === 3 ? 'exact' : 'lower-bound' });
            expect(page.population).toBe(population);
            if (n === 3) expect(page.next).toBeNull();
            else expect(page.next).not.toBeNull();
            continuation = page.next ?? undefined;
          }
        }));
        expect(delivered.map(row => row.work)).toEqual(expected.map(row => row.work));
        expect(submitted).toEqual([1, 1, 1, 1]);
        expect(disclosed).toEqual([1, 1, 1, 0]);
        baseline ??= requests;
        expect(requests).toEqual(baseline);
      }
    }
  }
});

// The HTTP capture reached its final health call after the wall deadline while
// the event-loop timer was still pending. No new fence read may start there.
test('the search owner starts no graph fence after its deadline even before the abort timer runs', async () => {
  const fixture = indexed('25');
  let fences = 0;
  const original = fixture.client.query.bind(fixture.client);
  fixture.client.query = async (...args) => {
    if (args[0].includes('LIMIT 2')) fences++;
    return original(...args);
  };
  const controller = new AbortController();
  const budget = { signal: controller.signal, callsLeft: 72, bytesLeft: 8_388_608, deadline: Infinity };
  await expect(fusekiReadBudget.run(budget, () => withSearchGraphSnapshot(
    { fuseki: fixture.client, lineage, objectDirectory: '.temp/search-availability-owner' }, async () => {
      budget.deadline = performance.now() - 1;
      return { results: [] };
    }))).rejects.toBeInstanceOf(SearchRequestTimedOut);
  expect(controller.signal.aborted).toBe(false);
  expect(fences).toBe(0);
});

test('a fence that consumes the remaining budget starts no final health read', async () => {
  for (const graphBasis of ['matching-cut', 'selected-units'] as const) {
    const fixture = indexed('25');
    const controller = new AbortController();
    const budget = { signal: controller.signal, callsLeft: 72, bytesLeft: 8_388_608, deadline: Infinity };
    let healthReads = 0;
    const health = fixture.client.commandHealth.bind(fixture.client);
    fixture.client.commandHealth = async () => { healthReads++; return health(); };
    const query = fixture.client.query.bind(fixture.client);
    fixture.client.query = async (...args) => {
      if (args[0].includes('LIMIT 2')) budget.deadline = performance.now() - 1;
      return query(...args);
    };
    await expect(fusekiReadBudget.run(budget, () => withSearchGraphSnapshot(
      { fuseki: fixture.client, lineage, objectDirectory: '.temp/search-availability-owner' }, async () => {
        healthReads = 0;
        return { results: [] };
      }, graphBasis))).rejects.toBeInstanceOf(SearchRequestTimedOut);
    expect(healthReads).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  }
});

test('completed search cannot beat a pending wall timer with an expired result', async () => {
  let cancelled = false;
  await expect(withStableSearchSnapshot(undefined, async () => {
    fusekiReadBudget.getStore()!.signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
    const stop = performance.now() + 15;
    while (performance.now() < stop) { /* Hold the timer until completion's microtask. */ }
    return { results: [] };
  }, 5)).rejects.toBeInstanceOf(SearchRequestTimedOut);
  expect(cancelled).toBe(true);
});

test('readiness consuming the wall budget admits no matching or hydration callback', async () => {
  const fixture = indexed('25');
  const budget = { signal: new AbortController().signal, callsLeft: 72, bytesLeft: 8_388_608, deadline: Infinity };
  const proof = fixture.client.searchDeltaSince.bind(fixture.client);
  fixture.client.searchDeltaSince = async (...args) => {
    const result = await proof(...args);
    budget.deadline = performance.now() - 1;
    return result;
  };
  let reads = 0;
  await expect(fusekiReadBudget.run(budget, () => withSearchGraphSnapshot(
    { fuseki: fixture.client, lineage, objectDirectory: '.temp/search-availability-owner' }, async () => { reads++; })))
    .rejects.toBeInstanceOf(SearchRequestTimedOut);
  expect(reads).toBe(0);
});
