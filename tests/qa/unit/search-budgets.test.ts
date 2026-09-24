import { expect, test } from 'bun:test';
import { FusekiClient, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded,
  fusekiReadBudget, type SparqlResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable,
  queryPublicMainClassifiedPhrase, queryPublicMainPhrase }
  from '../../../services/main/src/modules/work/search-public.ts';
import { assertPublicTextReady, assertQuerySnapshotMoved, SearchIndexUnavailable, SearchRequestTimedOut,
  SearchSnapshotMoved, withStableSearchSnapshot }
  from '../../../services/main/src/modules/work/search-readiness.ts';

const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const work = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const main = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
const sense = 'https://rezics.com/id/33333333-3333-4333-8333-333333333333';
const binding = (value: string) => ({ type: 'literal', value });

function fake() {
  let sequence = '7';
  let population = 102;
  let indexed = 102;
  let instanceId = '11111111-1111-4111-8111-111111111111';
  let publicSearchWriteEpoch = 0;
  let publicSearchWriteActive = false;
  let candidateCount = 513;
  let inventories = 0;
  let controls = 0;
  let healthCalls = 0;
  let queryCalls = 0;
  const fuseki = { commandHealth: async () => {
    healthCalls++;
    return { moduleVersion: '0.5.10', profiles: {}, instanceId,
      publicSearchWriteEpoch: String(publicSearchWriteEpoch), publicSearchWriteActive };
  },
    query: async (sparql: string): Promise<SparqlResult> => {
    queryCalls++;
    if (sparql.includes('ASK {')) return { boolean: true };
    if (sparql.includes('?probeScore')) {
      controls++;
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        generation: binding(generation) }] } };
    }
    if (sparql.includes('"body:*"')) {
      inventories++;
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        generation: binding(generation), population: binding(String(population)),
        indexed: binding(String(indexed)), uniqueIndexed: binding(String(indexed)),
        valid: binding(String(indexed)) }] } };
    }
    if (sparql.includes('?globalApplication')) {
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        main: binding(main), globalApplication: binding(work) }] } };
    }
    if (sparql.includes('?context WHERE')) {
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        context: binding('urn:rezics:classification-context:global') }] } };
    }
    if (sparql.includes('?candidateCount')) {
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        indexGeneration: binding(generation), candidateCount: binding(String(candidateCount)),
        ...(candidateCount === 1 ? { unit: binding('urn:rezics:match:one'),
          score: binding('1'), work: binding(work), main: binding(main),
          contribution: binding(work), revision: binding(work), selection: binding(work),
          language: binding('en') } : {}) }] } };
    }
    throw new Error('unexpected SPARQL');
  } } as FusekiClient;
  return { fuseki, counts: () => ({ inventories, controls, healthCalls, queryCalls }),
    advance: () => { sequence = String(Number(sequence) + 1); },
    mutateIndex: () => { sequence = String(Number(sequence) + 1); publicSearchWriteEpoch += 2; },
    beginIndexWrite: () => { publicSearchWriteEpoch++; publicSearchWriteActive = true; },
    endIndexWrite: () => { publicSearchWriteEpoch++; publicSearchWriteActive = false; },
    restart: () => { instanceId = '22222222-2222-4222-8222-222222222222'; },
    breakIndex: () => { indexed = population - 1; },
    oneCandidate: () => { candidateCount = 1; },
  };
}

test('SEARCH15/SEARCH18: readiness singleflight is position and JVM-bound', async () => {
  const source = fake();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  const first = await Promise.all(Array.from({ length: 5 },
    () => assertPublicTextReady(source.fuseki, lineage)));
  expect(first.every(value => value.population === 102 && value.sequence === '7')).toBe(true);
  expect(source.counts()).toMatchObject({ inventories: 1, controls: 5,
    healthCalls: 10, queryCalls: 6 });
  await assertPublicTextReady(source.fuseki, lineage);
  expect(source.counts()).toMatchObject({ inventories: 1, controls: 6,
    healthCalls: 12, queryCalls: 7 });
  source.restart();
  source.breakIndex();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(source.counts()).toMatchObject({ inventories: 2, controls: 7,
    healthCalls: 13, queryCalls: 9 });
  source.advance();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(source.counts()).toMatchObject({ inventories: 3, controls: 8,
    healthCalls: 14, queryCalls: 11 });
});

test('SEARCH15/SEARCH18: empty readiness control retries only across a native write epoch', async () => {
  let writeEpoch = '0';
  let moveDuringControl = true;
  const fuseki = { commandHealth: async () => ({ moduleVersion: '0.5.10', profiles: {},
    instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: writeEpoch, publicSearchWriteActive: false }),
  query: async (): Promise<SparqlResult> => {
    if (moveDuringControl) writeEpoch = '2';
    return { results: { bindings: [] } };
  } } as FusekiClient;
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  await expect(assertPublicTextReady(fuseki, lineage)).rejects.toBeInstanceOf(SearchSnapshotMoved);
  moveDuringControl = false;
  await expect(assertPublicTextReady(fuseki, lineage)).rejects.toBeInstanceOf(SearchIndexUnavailable);
});

test('SEARCH15/SEARCH18: metadata sequence reuse keeps the full index proof, public write invalidates it', async () => {
  const source = fake();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  const first = await assertPublicTextReady(source.fuseki, lineage);
  expect(first.publicSearchWriteEpoch).toBe('0');
  source.advance();
  const metadata = await assertPublicTextReady(source.fuseki, lineage);
  expect(metadata.sequence).toBe('8');
  expect(source.counts().inventories).toBe(1);
  source.beginIndexWrite();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchSnapshotMoved);
  source.endIndexWrite();
  const changed = await assertPublicTextReady(source.fuseki, lineage);
  expect(changed.publicSearchWriteEpoch).toBe('2');
  expect(source.counts().inventories).toBe(2);
});

test('SEARCH02/SEARCH10: a 513th raw hit cannot become a false complete empty result', async () => {
  const source = fake();
  const env = { fuseki: source.fuseki,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '/unused' } as WorkActivationEnvironment;
  await expect(queryPublicMainPhrase(env, { phrase: 'late match', language: 'en' }))
    .rejects.toBeInstanceOf(PublicQueryBudgetExceeded);
  expect(source.counts()).toMatchObject({ inventories: 1, healthCalls: 3, queryCalls: 4 });
});

test('SEARCH10: batched classification fails closed on a present application without a decision', async () => {
  const source = fake();
  source.oneCandidate();
  const env = { fuseki: source.fuseki,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '/unused' } as WorkActivationEnvironment;
  await expect(queryPublicMainClassifiedPhrase(env,
    { phrase: 'late match', language: 'en', sense }))
    .rejects.toBeInstanceOf(PublicQueryUnavailable);
});

test('SEARCH10/SEARCH18: a streamed Fuseki response stops at the byte ceiling', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":'));
        controller.enqueue(new TextEncoder().encode('{"bindings":[]}}'));
        controller.close();
      },
    }), { status: 200 }),
  });
  try {
    const fuseki = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
    await expect(fuseki.query('ASK {}', 16))
      .rejects.toBeInstanceOf(FusekiQueryResponseTooLarge);
  } finally {
    server.stop(true);
  }
});

test('SEARCH18: one request counts Fuseki calls and response bytes across reads', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => Response.json({ results: { bindings: [] } }),
  });
  try {
    const fuseki = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
    const signal = new AbortController().signal;
    await fusekiReadBudget.run({ signal, callsLeft: 1, bytesLeft: 1_024 }, async () => {
      await fuseki.query('ASK {}', 1_024);
      await expect(fuseki.query('ASK {}', 1_024))
        .rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    });
    await fusekiReadBudget.run({ signal, callsLeft: 2, bytesLeft: 50 }, async () => {
      await fuseki.query('ASK {}', 1_024);
      await expect(fuseki.query('ASK {}', 1_024))
        .rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    });
  } finally {
    server.stop(true);
  }
});

test('SEARCH18: only proven snapshot movement receives at most three attempts', async () => {
  let attempts = 0;
  const started = performance.now();
  const result = await withStableSearchSnapshot(undefined, async () => {
    attempts++;
    if (attempts < 3) throw new SearchSnapshotMoved('position changed');
    return 'complete';
  });
  expect(result).toBe('complete');
  expect(attempts).toBe(3);
  expect(performance.now() - started).toBeGreaterThanOrEqual(300);
  await expect(withStableSearchSnapshot(undefined, async () => {
    attempts++;
    throw new SearchSnapshotMoved('position changed');
  })).rejects.toBeInstanceOf(SearchSnapshotMoved);
  expect(attempts).toBe(6);
  await expect(withStableSearchSnapshot(undefined, async () => {
    attempts++;
    throw new SearchIndexUnavailable('index differs from RDF');
  })).rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(attempts).toBe(7);
});

test('SEARCH18: a native public-index writer is polled until its epoch is even', async () => {
  const source = fake();
  source.beginIndexWrite();
  const release = setTimeout(() => source.endIndexWrite(), 180);
  const started = performance.now();
  let attempts = 0;
  try {
    const result = await withStableSearchSnapshot(source.fuseki, async () => {
      attempts++;
      await assertPublicTextReady(source.fuseki, { dataEpoch: 'epoch', routingEpoch: 'routing' });
      return 'ready';
    });
    expect(result).toBe('ready');
    expect(attempts).toBe(2);
    expect(performance.now() - started).toBeGreaterThanOrEqual(180);
    expect(source.counts().healthCalls).toBeGreaterThan(3);
  } finally { clearTimeout(release); }
});

test('SEARCH18: stalled read is cut off by one request wall deadline', async () => {
  const started = performance.now();
  await expect(withStableSearchSnapshot(undefined, () => new Promise<never>(() => {}), 20))
    .rejects.toBeInstanceOf(SearchRequestTimedOut);
  expect(performance.now() - started).toBeLessThan(300);
});

test('SEARCH15/SEARCH18: only an anchored, changed control is a retryable empty snapshot', async () => {
  const position = { dataEpoch: 'epoch', sequence: '7', generation };
  let rows: SparqlResult['results'] = { bindings: [] };
  const fuseki = { query: async () => ({ results: rows }) } as unknown as FusekiClient;
  await expect(assertQuerySnapshotMoved(fuseki, position, [], 'indexGeneration')).resolves.toBeUndefined();
  rows = { bindings: [{ epoch: binding('epoch'), sequence: binding('8'),
    generation: binding(generation) }] };
  await expect(assertQuerySnapshotMoved(fuseki, position, [], 'indexGeneration'))
    .rejects.toBeInstanceOf(SearchSnapshotMoved);
  await expect(assertQuerySnapshotMoved(fuseki, position, [{ epoch: binding('epoch'),
    sequence: binding('8'), indexGeneration: binding(generation) }], 'indexGeneration'))
    .rejects.toBeInstanceOf(SearchSnapshotMoved);
  await expect(assertQuerySnapshotMoved(fuseki, position, [{ epoch: binding('epoch'),
    sequence: binding('bad'), indexGeneration: binding(generation) }], 'indexGeneration'))
    .resolves.toBeUndefined();
});
