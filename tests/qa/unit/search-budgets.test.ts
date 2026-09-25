import { expect, test } from 'bun:test';
import { FusekiClient, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded,
  fusekiReadBudget, type SparqlResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable,
  queryPublicMainClassifiedPhrase, queryPublicMainPhrase, queryPublicRealmPhrase }
  from '../../../services/main/src/modules/work/search-public.ts';
import { queryPublicRealmClassifiedRatedPhrase }
  from '../../../services/main/src/modules/work/search-joined.ts';
import { queryPublicContentPhrase }
  from '../../../services/main/src/modules/content-publication/search.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { ContentCore } from '../../../services/content/src/core.ts';
import type { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { assertPublicTextReady, assertQuerySnapshotMoved, SearchIndexUnavailable, SearchRequestTimedOut,
  SearchSnapshotMoved, withStableSearchSnapshot, type SearchAttemptDiagnostic }
  from '../../../services/main/src/modules/work/search-readiness.ts';

const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const work = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const main = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
const sense = 'https://rezics.com/id/33333333-3333-4333-8333-333333333333';
const binding = (value: string) => ({ type: 'literal', value });

function fake() {
  let sequence = '7';
  let generationCurrent = generation;
  let population = 102;
  let indexed = 102;
  let instanceId = '11111111-1111-4111-8111-111111111111';
  let publicSearchWriteEpoch = 0;
  let publicSearchWriteActive = false;
  let deltaAvailable = false;
  let nativeProofValid = true;
  let ordinal = 0;
  let nativeDeltas: { ordinal: string; dataEpoch: string; sequence: string; generation: string;
    writeEpoch: string; changes: { unit: string; before: boolean; after: boolean }[] }[] = [];
  let deltaCalls = 0;
  let deltaGap = false;
  let candidateCount = 513;
  let inventories = 0;
  let controls = 0;
  let healthCalls = 0;
  let queryCalls = 0;
  const fuseki = { commandHealth: async () => {
    healthCalls++;
    return { moduleVersion: '0.5.20', profiles: {}, instanceId,
      publicSearchWriteEpoch: String(publicSearchWriteEpoch), publicSearchWriteActive,
      publicSearchDeltaAvailable: deltaAvailable };
  },
    searchDeltaSince: async (since: string) => {
      deltaCalls++;
      return { available: deltaAvailable && nativeProofValid, ordinal: String(ordinal), dataEpoch: 'epoch',
        sequence, generation: generationCurrent, writeEpoch: String(publicSearchWriteEpoch), luceneGeneration: '1',
        deltas: since === '-1' ? [] : nativeDeltas.filter(delta => Number(delta.ordinal) > Number(since))
          .map(delta => deltaGap ? { ...delta, ordinal: String(Number(delta.ordinal) + 1) } : delta) };
    },
    query: async (sparql: string): Promise<SparqlResult> => {
    queryCalls++;
    if (sparql.includes('ASK {')) return { boolean: true };
    if (sparql.includes('?probeScore')) {
      controls++;
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        generation: binding(generationCurrent) }] } };
    }
    if (sparql.includes('"body:*"')) {
      inventories++;
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        generation: binding(generationCurrent), population: binding(String(population)),
        indexed: binding(String(indexed)), uniqueIndexed: binding(String(indexed)),
        valid: binding(String(indexed)) }] } };
    }
    if (sparql.includes('?ratingPopulation') && sparql.includes('text:query')) {
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        indexGeneration: binding(generationCurrent),
        candidateCount: binding(String(candidateCount)), ratingPopulation: binding('0'),
        ratingRows: binding('0'), ratingUniqueSlots: binding('0'),
        ratingValidRows: binding('0') }] } };
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
        indexGeneration: binding(generationCurrent), candidateCount: binding(String(candidateCount)),
        ...(candidateCount === 1 ? { unit: binding('urn:rezics:match:one'),
          score: binding('1'), work: binding(work), main: binding(main),
          contribution: binding(work), revision: binding(work), selection: binding(work),
          language: binding('en') } : {}) }] } };
    }
    throw new Error('unexpected SPARQL');
  } } as FusekiClient;
  return { fuseki, counts: () => ({ inventories, controls, healthCalls, queryCalls, deltaCalls }),
    enableDelta: () => { deltaAvailable = true; },
    disableDelta: () => { deltaAvailable = false; },
    invalidateNativeProof: () => { nativeProofValid = false; },
    gapDelta: () => { deltaGap = true; },
    commitDelta: (changes: { unit: string; before: boolean; after: boolean }[]) => {
      sequence = String(Number(sequence) + 1);
      publicSearchWriteEpoch += 2;
      ordinal++;
      nativeDeltas.push({ ordinal: String(ordinal), dataEpoch: 'epoch', sequence,
        generation: generationCurrent, writeEpoch: String(publicSearchWriteEpoch), changes });
      population += changes.reduce((sum, change) => sum + Number(change.after) - Number(change.before), 0);
      indexed = population;
    },
    advance: () => { sequence = String(Number(sequence) + 1); },
    mutateIndex: () => { sequence = String(Number(sequence) + 1); publicSearchWriteEpoch += 2; },
    abortIndexWrite: () => { publicSearchWriteEpoch += 2; },
    beginIndexWrite: () => { publicSearchWriteEpoch++; publicSearchWriteActive = true; },
    endIndexWrite: () => { publicSearchWriteEpoch++; publicSearchWriteActive = false; },
    restart: () => { instanceId = '22222222-2222-4222-8222-222222222222'; },
    changeGeneration: () => { generationCurrent =
      'urn:rezics:text-index-generation:22222222-2222-4222-8222-222222222222'; },
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
  const fuseki = { commandHealth: async () => ({ moduleVersion: '0.5.20', profiles: {},
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

test('SEARCH18: simple Main and Realm phrases accept a later coherent metadata snapshot', async () => {
  for (const lane of ['main', 'realm'] as const) {
    const source = fake();
    source.oneCandidate();
    const original = source.fuseki.query.bind(source.fuseki);
    let advanced = false;
    source.fuseki.query = async (sparql: string, maxResponseBytes?: number) => {
      if (sparql.includes('?candidateCount') && !advanced) {
        source.advance();
        advanced = true;
      }
      const answer = await original(sparql, maxResponseBytes);
      if (lane === 'realm' && sparql.includes('?candidateCount') && answer.results) {
        for (const row of answer.results.bindings) row.reason = binding('main-fallback');
      }
      return answer;
    };
    const env = { fuseki: source.fuseki,
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, objectDirectory: '' };
    const result = lane === 'main'
      ? await queryPublicMainPhrase(env, { phrase: 'coherent token', language: 'en' })
      : await queryPublicRealmPhrase(env, { phrase: 'coherent token', language: 'en',
        context: { kind: 'realm-local', id: work } });
    expect(result.complete).toBe(true);
    expect(result.total).toBe(1);
    expect(result.sourcePosition.sequence).toBe('8');
    expect(source.counts().inventories).toBe(1);
  }
});

test('SEARCH18: a native index mutation during the phrase relation still rejects the read', async () => {
  const source = fake();
  source.oneCandidate();
  const original = source.fuseki.query.bind(source.fuseki);
  let mutated = false;
  source.fuseki.query = async (sparql: string, maxResponseBytes?: number) => {
    if (sparql.includes('?candidateCount') && !mutated) {
      source.mutateIndex();
      mutated = true;
    }
    return original(sparql, maxResponseBytes);
  };
  await expect(queryPublicMainPhrase({ fuseki: source.fuseki,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, objectDirectory: '' },
  { phrase: 'coherent token', language: 'en' })).rejects.toBeInstanceOf(SearchSnapshotMoved);
});

test('SEARCH18: Content audits a later metadata cut and pins its phrase to that cut', async () => {
  const source = fake();
  const originalHealth = source.fuseki.commandHealth.bind(source.fuseki);
  source.fuseki.commandHealth = async () => ({ ...await originalHealth(), profiles: {
    'content-match-unit-v1': profileRegistry['content-match-unit-v1'].sha256,
    'content-search-eligibility-v1': profileRegistry['content-search-eligibility-v1'].sha256,
  } });
  const originalQuery = source.fuseki.query.bind(source.fuseki);
  let advanced = false;
  source.fuseki.query = async (sparql: string, maxResponseBytes?: number) => {
    if (sparql.includes('?declared ?heads')) {
      if (!advanced) { source.advance(); advanced = true; }
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding('8'),
        generation: binding(generation), declared: binding('1'), heads: binding('1'),
        missing: binding('0'), eligible: binding('1'), contentUnits: binding('1') }] } };
    }
    if (sparql.includes('?resource ?variant ?revision ?decision ?eligibility ?language')) {
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding('8'),
        generation: binding(generation), candidateCount: binding('1'),
        unit: binding('urn:rezics:content:match-unit:one'), score: binding('1'),
        resource: binding(work), variant: binding('urn:rezics:variant:one'),
        revision: binding('urn:rezics:content:revision:11111111-1111-4111-8111-111111111111'),
        decision: binding('urn:rezics:content:decision:one'),
        eligibility: binding('urn:rezics:content:eligibility:one'), language: binding('en') }] } };
    }
    return originalQuery(sparql, maxResponseBytes);
  };
  const position = { owner: 'content' as const, dataEpoch: 'content-epoch', sequence: '3' };
  const content = { ownerPosition: async () => position } as ContentCore;
  const cursor = { read: async () => position } as ContentProjectionCursor;
  const result = await queryPublicContentPhrase({ fuseki: source.fuseki,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, objectDirectory: '' },
  content, cursor, 'main-content-public-search-v1', { phrase: 'exact content beacon', language: 'en' });
  expect(result.complete).toBe(true);
  expect(result.total).toBe(1);
  expect(result.graphPosition.sequence).toBe('8');
  expect(result.contentPosition).toEqual(position);
});

test('SEARCH07/SEARCH15/SEARCH18: certified affected-unit replay avoids a corpus inventory', async () => {
  const source = fake();
  source.enableDelta();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(102);
  expect(source.counts()).toMatchObject({ inventories: 1, deltaCalls: 1 });
  source.commitDelta([{ unit: 'urn:rezics:match:old', before: true, after: false },
    { unit: 'urn:rezics:match:new', before: false, after: true }]);
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(102);
  expect(source.counts()).toMatchObject({ inventories: 1, deltaCalls: 2 });
  source.commitDelta([{ unit: 'urn:rezics:match:new', before: true, after: true }]);
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(102);
  expect(source.counts()).toMatchObject({ inventories: 1, deltaCalls: 3 });
});

test('SEARCH15/SEARCH17/SEARCH18: gap, bypass gate, restart and generation force a full audit', async () => {
  const source = fake();
  source.enableDelta();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  await assertPublicTextReady(source.fuseki, lineage);
  source.commitDelta([{ unit: 'urn:rezics:match:new', before: false, after: true }]);
  source.gapDelta();
  await assertPublicTextReady(source.fuseki, lineage);
  expect(source.counts().inventories).toBe(2);
  source.disableDelta();
  source.commitDelta([{ unit: 'urn:rezics:match:other', before: false, after: true }]);
  await assertPublicTextReady(source.fuseki, lineage);
  expect(source.counts().inventories).toBe(3);
  source.restart();
  await assertPublicTextReady(source.fuseki, lineage);
  expect(source.counts().inventories).toBe(4);
  source.changeGeneration();
  await assertPublicTextReady(source.fuseki, lineage);
  expect(source.counts().inventories).toBe(5);
});

test('SEARCH15: a failed exact-subject native proof cannot report a complete result', async () => {
  const source = fake();
  source.enableDelta();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  await assertPublicTextReady(source.fuseki, lineage);
  source.commitDelta([{ unit: 'urn:rezics:match:new', before: false, after: true }]);
  source.invalidateNativeProof();
  source.breakIndex();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(source.counts().inventories).toBe(2);
});

test('SEARCH15: an intervening aborted text write prevents delta replay', async () => {
  const source = fake();
  source.enableDelta();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  await assertPublicTextReady(source.fuseki, lineage);
  source.abortIndexWrite();
  source.commitDelta([{ unit: 'urn:rezics:match:new', before: false, after: true }]);
  await assertPublicTextReady(source.fuseki, lineage);
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

test('SEARCH04/SEARCH10: the rated Realm join rejects an over-budget raw hit set before dedupe', async () => {
  const source = fake();
  const env = { fuseki: source.fuseki,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '/unused' } as WorkActivationEnvironment;
  await expect(queryPublicRealmClassifiedRatedPhrase(env,
    { context: { kind: 'realm-local', id: work }, phrase: 'late match', language: 'en',
      sense, ratingContext: main, minimumMeanTimes10: 80 }))
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

test('SEARCH18: a fourth read can finish after three consecutive native position movements', async () => {
  let attempts = 0;
  const source = fake();
  const started = performance.now();
  const result = await withStableSearchSnapshot(source.fuseki, async () => {
    attempts++;
    if (attempts <= 3) {
      source.mutateIndex();
      throw new SearchSnapshotMoved('position changed');
    }
    await assertPublicTextReady(source.fuseki, { dataEpoch: 'epoch', routingEpoch: 'routing' });
    return 'complete';
  });
  expect(result).toBe('complete');
  expect(attempts).toBe(4);
  expect(performance.now() - started).toBeGreaterThanOrEqual(375);
  expect(performance.now() - started).toBeLessThan(1_500);
  await expect(withStableSearchSnapshot(source.fuseki, async () => {
    attempts++;
    throw new SearchSnapshotMoved('position changed');
  }, 450)).rejects.toBeInstanceOf(SearchRequestTimedOut);
  expect(attempts).toBeGreaterThan(4);
  await expect(withStableSearchSnapshot(source.fuseki, async () => {
    attempts++;
    throw new SearchIndexUnavailable('index differs from RDF');
  })).rejects.toBeInstanceOf(SearchIndexUnavailable);
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

test('SEARCH18: a writer outliving the read deadline is reported with its retry phase', async () => {
  const source = fake();
  source.beginIndexWrite();
  const release = setTimeout(() => source.endIndexWrite(), 200);
  const diagnostics: SearchAttemptDiagnostic[] = [];
  const started = performance.now();
  try {
    await expect(withStableSearchSnapshot(source.fuseki, async () => {
      await assertPublicTextReady(source.fuseki, { dataEpoch: 'epoch', routingEpoch: 'routing' });
    }, 120, diagnostics)).rejects.toBeInstanceOf(SearchRequestTimedOut);
    expect(performance.now() - started).toBeLessThan(250);
    expect(diagnostics.map(item => [item.phase, item.error])).toEqual([
      ['read', 'SearchSnapshotMoved'], ['writer-wait', 'SearchRequestTimedOut'],
    ]);
    expect(diagnostics[0]?.message).toContain('write is in progress');
  } finally { clearTimeout(release); source.endIndexWrite(); }
  await expect(withStableSearchSnapshot(source.fuseki, async () => {
    await assertPublicTextReady(source.fuseki, { dataEpoch: 'epoch', routingEpoch: 'routing' });
  })).resolves.toBeUndefined();
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
