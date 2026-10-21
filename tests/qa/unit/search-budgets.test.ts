import { expect, test } from 'bun:test';
import { FusekiClient, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded,
  fusekiReadBudget, type SparqlResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { DATASET, RV, type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
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
import { assertPublicTextReady, assertQuerySnapshotMoved,
  SearchIndexUnavailable, SearchRequestTimedOut,
  SearchSnapshotMoved, withStableSearchSnapshot, type SearchAttemptDiagnostic }
  from '../../../services/main/src/modules/work/search-readiness.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri } from '../../../services/main/src/modules/content-publication/eligibility.ts';
import { contentPublicationDecisionIri, contentPublicationReceiptIri }
  from '../../../services/main/src/modules/content-publication/publish.ts';
import { projectOccurrenceLabelsOnce } from '../../../services/main/src/modules/structure/label-index-backfill.ts';
import { searchRoutes } from '../../../services/main/src/routes/search.ts';

const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const instanceId = '11111111-1111-4111-8111-111111111111';

test('native consistent capture and exact unit probe capabilities are typed and default to unavailable', async () => {
  let flags: Record<string, unknown> = {};
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return Response.json({ moduleVersion: COMMAND_MODULE_VERSION, instanceId,
      publicSearchWriteEpoch: '1', publicSearchWriteActive: true, profiles: {}, ...flags });
  } });
  try {
    const fuseki = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
    expect(await fuseki.commandHealth()).toMatchObject({ consistentCaptureAvailable: false, exactUnitProbeAvailable: false });
    flags = { consistentCaptureAvailable: true, exactUnitProbeAvailable: true };
    expect(await fuseki.commandHealth()).toMatchObject({ consistentCaptureAvailable: true, exactUnitProbeAvailable: true });
    for (const flag of ['consistentCaptureAvailable', 'exactUnitProbeAvailable']) {
      flags = { [flag]: 'true' };
      await expect(fuseki.commandHealth()).rejects.toThrow('malformed Fuseki command health');
    }
  } finally { await server.stop(true); }
});

test('occurrence maintenance names its native discovery phase without sending query text as evidence', async () => {
  const phases: (string | null)[] = [];
  const budgets: (string | null)[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    phases.push(request.headers.get('x-rezics-native-phase'));
    budgets.push(request.headers.get('x-rezics-search-budget-ms'));
    return Response.json({ results: { bindings: [] } });
  } });
  try {
    const fuseki = new FusekiClient(`http://127.0.0.1:${server.port}/rezics`);
    await fuseki.query('ASK {}');
    const env = { fuseki } as WorkActivationEnvironment;
    expect(await projectOccurrenceLabelsOnce(env)).toBe(false);
    expect(phases).toEqual([null, 'occurrence-discovery']);
    expect(budgets).toEqual([null, null]);
  } finally { await server.stop(true); }
});

test('SEARCH18: typeahead timeout logs bounded Fuseki evidence without its prefix and keeps the 503 problem', async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const prefix = 'unlogged typeahead prefix 7b6e3d52';
  const errors: string[] = [];
  let queryCalls = 0;
  let activeSignal: AbortSignal | undefined;
  globalThis.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/query') || url.pathname.endsWith('/command') && init?.method === 'POST') {
      queryCalls++;
      if (queryCalls === 2) {
        activeSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          activeSignal?.addEventListener('abort', () => reject(new DOMException(prefix, 'AbortError')),
            { once: true });
        });
      }
      return Promise.resolve(Response.json({ results: { bindings: [{ epoch: binding('epoch'),
        sequence: binding('7'), generation: binding(generation) }] } }));
    }
    if (url.searchParams.has('deltaSince')) {
      return Promise.resolve(Response.json({ available: true, ordinal: '0', dataEpoch: 'epoch',
        sequence: '7', generation, writeEpoch: '0', luceneGeneration: '1',
        qualifiedPopulation: '1', deltas: [] }));
    }
    return Promise.resolve(Response.json({ moduleVersion: COMMAND_MODULE_VERSION, instanceId,
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      publicSearchDeltaAvailable: true, prefixWalkAvailable: true, profiles: {} }));
  }) as typeof fetch;
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(' ')); };
  try {
    const fuseki = new FusekiClient('http://127.0.0.1:3030/rezics', undefined, 'a'.repeat(64));
    const work = { environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
      access: { assertRecoveryOpen: async () => undefined } };
    const app = searchRoutes(fuseki, work as unknown as Parameters<typeof searchRoutes>[1]);
    const response = await app.handle(new Request(`http://main.local/v1/search/typeahead?prefix=${encodeURIComponent(prefix)}`));

    expect(queryCalls).toBe(2);
    expect(activeSignal?.aborted).toBe(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      type: 'https://rezics.com/problems/search_index_unavailable',
      title: 'Public text index is unavailable', status: 503, code: 'search_index_unavailable',
    });
    const events = errors.map(value => {
      try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
    }).filter((value): value is Record<string, unknown> => value?.event === 'public-search-timeout');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'public-search-timeout', route: 'typeahead',
      diagnostics: { active: [{ family: 'query', phase: 'read', status: 'active' }] } });
    const diagnosticOutput = JSON.stringify(events[0]?.diagnostics);
    expect(diagnosticOutput).not.toContain(prefix);
    const diagnostics = events[0]?.diagnostics as { history: unknown[]; active: unknown[] };
    expect(diagnostics.history.length).toBeLessThanOrEqual(8);
    expect(diagnostics.active.length).toBeLessThanOrEqual(8);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
}, 5_000);
const work = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const main = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
const sense = 'https://rezics.com/id/33333333-3333-4333-8333-333333333333';
const binding = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

function contentOwnerProof() {
  const variant = 'urn:rezics:variant:one';
  const revision = 'urn:rezics:content:revision:11111111-1111-4111-8111-111111111111';
  const publicationAdmission = '22222222-2222-4222-8222-222222222222';
  const eligibilityAdmission = '33333333-3333-4333-8333-333333333333';
  const preparation = '44444444-4444-4444-8444-444444444444';
  const actor = 'urn:rezics:actor:content-search-reviewer';
  const publication = contentPublicationDecisionIri(publicationAdmission);
  const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmission);
  const eligibilityInput = { resourceId: work, variantId: variant, publicationDecision: publication,
    expectedEligibilityHead: null, actingSubject: actor,
    rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };
  const makeRow = (key: string, id: string, receipt: string,
    fields: Array<[string, string | undefined, 'uri' | 'literal']>) => {
    const row: Record<string, { type: string; value: string }> = { [key]: uri(id),
      decisionTypeCount: binding('1'), anchorTypeCount: binding('1'), receiptCount: binding('1'),
      receipt: uri(receipt), receiptTypeCount: binding('1') };
    for (const [name, value, type] of fields) {
      row[`${name}Count`] = binding(value === undefined ? '0' : '1');
      if (value !== undefined) row[name] = type === 'uri' ? uri(value) : binding(value);
    }
    return row;
  };
  const publicationRow = makeRow('publication', publication, contentPublicationReceiptIri(publicationAdmission), [
    ['dComponent', variant, 'uri'], ['dResource', work, 'uri'], ['dRevision', revision, 'uri'],
    ['dDigest', 'a'.repeat(64), 'literal'], ['dOwnerEpoch', 'content-epoch', 'literal'],
    ['dOwnerSequence', '3', 'literal'], ['dDataEpoch', 'epoch', 'literal'], ['dSequence', '6', 'literal'],
    ['dModel', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-publication-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dPreparation', preparation, 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', 'b'.repeat(64), 'literal'], ['rAdmissionId', publicationAdmission, 'literal'],
    ['rAuthorityEpoch', '2', 'literal'], ['rScope', `content:publish:${variant}`, 'literal'],
    ['rPreparation', preparation, 'literal'], ['rRevision', revision, 'uri'], ['rVariant', variant, 'uri'],
    ['rResource', work, 'uri'], ['rByteDigest', 'a'.repeat(64), 'literal'],
    ['rOwnerEpoch', 'content-epoch', 'literal'], ['rOwnerSequence', '3', 'literal'],
    ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rDataset', DATASET, 'uri'],
    ['rDataEpoch', 'epoch', 'literal'], ['rSequence', '6', 'literal'], ['rDecision', publication, 'uri'],
  ]);
  const eligibilityRow = makeRow('eligibility', eligibility, contentSearchEligibilityReceiptIri(eligibilityAdmission), [
    ['dComponent', variant, 'uri'], ['dVariant', variant, 'uri'], ['dResource', work, 'uri'],
    ['dPublication', publication, 'uri'], ['dRightsBasis', `${RV}OriginalContribution`, 'uri'],
    ['dAssessment', undefined, 'uri'], ['dDisclosure', `${RV}Public`, 'uri'],
    ['dAdmissionId', eligibilityAdmission, 'literal'], ['dAuthorityEpoch', '2', 'literal'],
    ['dScope', `content:search-eligibility:${variant}`, 'literal'], ['dActor', actor, 'uri'],
    ['dModel', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dShape', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
    ['dDataset', DATASET, 'uri'], ['dDataEpoch', 'epoch', 'literal'], ['dSequence', '7', 'literal'],
    ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
    ['rRequestDigest', contentSearchEligibilityDigest(eligibilityInput), 'literal'],
    ['rAdmissionId', eligibilityAdmission, 'literal'], ['rAuthorityEpoch', '2', 'literal'],
    ['rScope', `content:search-eligibility:${variant}`, 'literal'], ['rActor', actor, 'uri'],
    ['rResource', work, 'uri'], ['rVariant', variant, 'uri'], ['rPublication', publication, 'uri'],
    ['rExpectedHead', 'urn:rezics:none', 'uri'], ['rRightsBasis', `${RV}OriginalContribution`, 'uri'],
    ['rAssessment', undefined, 'uri'], ['rDisclosure', `${RV}Public`, 'uri'], ['rDataset', DATASET, 'uri'],
    ['rDataEpoch', 'epoch', 'literal'], ['rSequence', '7', 'literal'], ['rEligibility', eligibility, 'uri'],
  ]);
  return { variant, revision, publication, eligibility, publicationRow, eligibilityRow };
}

function fake(initialPopulation = 102) {
  let sequence = '7';
  let generationCurrent = generation;
  let population = initialPopulation;
  let indexed = initialPopulation;
  let instanceId = '11111111-1111-4111-8111-111111111111';
  let publicSearchWriteEpoch = 0;
  let publicSearchWriteActive = false;
  let deltaAvailable = true;
  let nativeProofValid = true;
  let ordinal = 0;
  const proofRequests: string[] = [];
  let deltaCalls = 0;
  let qualifiedWriteEpoch = 0;
  let candidateCount = 513;
  let inventories = 0;
  let controls = 0;
  let healthCalls = 0;
  let queryCalls = 0;
  const fuseki = { commandHealth: async () => {
    healthCalls++;
    return { moduleVersion: COMMAND_MODULE_VERSION, profiles: {}, instanceId,
      publicSearchWriteEpoch: String(publicSearchWriteEpoch), publicSearchWriteActive,
      publicSearchDeltaAvailable: deltaAvailable };
  },
    searchDeltaSince: async (since: string) => {
      deltaCalls++;
      proofRequests.push(since);
      const qualified = nativeProofValid && indexed === population && qualifiedWriteEpoch === publicSearchWriteEpoch;
      return { available: deltaAvailable && qualified, ordinal: String(ordinal), dataEpoch: 'epoch',
        sequence, generation: generationCurrent, writeEpoch: String(publicSearchWriteEpoch), luceneGeneration: '1',
        qualifiedPopulation: qualified ? String(population) : undefined, deltas: [] };
    },
    query: async (sparql: string): Promise<SparqlResult> => {
    queryCalls++;
    if (sparql.includes('ASK {')) return { boolean: true };
    if (sparql.includes('SELECT ?epoch ?sequence ?generation')) {
      controls++;
      const audit = sparql.includes('rv:publicTextInventory()');
      if (audit) {
        inventories++;
        if (indexed !== population) throw new Error('native index differs from RDF membership');
      }
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        generation: binding(generationCurrent), ...(audit ? { population: binding(String(population)) } : {}) }] } };
    }
    if (sparql.includes('?ratingPopulation') && sparql.includes('text:query')) {
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        indexGeneration: binding(generationCurrent),
        candidateCount: binding(String(candidateCount)), ratingPopulation: binding('0'),
        ratingRows: binding('0'), ratingUniqueSlots: binding('0'),
        ratingValidRows: binding('0') }] } };
    }
    if (sparql.includes('?main ?key ?localFound ?localDecision')) {
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        main: binding(main), globalFound: binding(work) }] } };
    }
    if (sparql.includes('?senseRevision ?concept WHERE')) {
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding(sequence),
        context: binding('urn:rezics:classification-context:global'),
        senseRevision: binding(main), concept: binding(work) }] } };
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
    disableDelta: () => { deltaAvailable = false; },
    invalidateNativeProof: () => { nativeProofValid = false; },
    proofRequests: () => [...proofRequests],
    commitDelta: (changes: { unit: string; before: boolean; after: boolean }[]) => {
      sequence = String(Number(sequence) + 1);
      publicSearchWriteEpoch += 2;
      ordinal++;
      qualifiedWriteEpoch = publicSearchWriteEpoch;
      population += changes.reduce((sum, change) => sum + Number(change.after) - Number(change.before), 0);
      indexed = population;
    },
    advance: () => { sequence = String(Number(sequence) + 1); },
    mutateIndex: () => { sequence = String(Number(sequence) + 1); publicSearchWriteEpoch += 2;
      qualifiedWriteEpoch = publicSearchWriteEpoch; },
    abortIndexWrite: () => { publicSearchWriteEpoch += 2; },
    beginIndexWrite: () => { publicSearchWriteEpoch++; publicSearchWriteActive = true; },
    endIndexWrite: () => { publicSearchWriteEpoch++; publicSearchWriteActive = false; qualifiedWriteEpoch = publicSearchWriteEpoch; },
    restart: () => { instanceId = '22222222-2222-4222-8222-222222222222'; },
    changeGeneration: () => { generationCurrent =
      'urn:rezics:text-index-generation:22222222-2222-4222-8222-222222222222'; },
    breakIndex: () => { indexed = population - 1; },
    oneCandidate: () => { candidateCount = 1; },
  };
}

test('SEARCH15/SEARCH18: each readiness proof is position and JVM-bound without a corpus scan', async () => {
  const source = fake();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  const first = await Promise.all(Array.from({ length: 5 },
    () => assertPublicTextReady(source.fuseki, lineage)));
  expect(first.every(value => value.population === 102 && value.sequence === '7')).toBe(true);
  expect(source.counts()).toEqual({ inventories: 0, controls: 5,
    healthCalls: 10, queryCalls: 5, deltaCalls: 5 });
  source.restart();
  const restarted = await assertPublicTextReady(source.fuseki, lineage);
  expect(restarted.serverInstanceId).toBe('22222222-2222-4222-8222-222222222222');
  source.breakIndex();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  source.advance();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(source.counts().inventories).toBe(0);
  expect(source.proofRequests()).toEqual(Array(8).fill('-1'));
});

test('SEARCH15/SEARCH18: empty readiness control retries only across a native write epoch', async () => {
  let writeEpoch = '0';
  let moveDuringControl = true;
  const fuseki = { commandHealth: async () => ({ moduleVersion: COMMAND_MODULE_VERSION, profiles: {},
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

test('SEARCH15/SEARCH18: metadata and completed writes require a coherent native qualification', async () => {
  const source = fake();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  const first = await assertPublicTextReady(source.fuseki, lineage);
  expect(first.publicSearchWriteEpoch).toBe('0');
  source.advance();
  const metadata = await assertPublicTextReady(source.fuseki, lineage);
  expect(metadata.sequence).toBe('8');
  expect(source.counts().deltaCalls).toBe(2);
  source.beginIndexWrite();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchSnapshotMoved);
  expect(source.counts().deltaCalls).toBe(2);
  source.endIndexWrite();
  const changed = await assertPublicTextReady(source.fuseki, lineage);
  expect(changed.publicSearchWriteEpoch).toBe('2');
  expect(source.counts().deltaCalls).toBe(3);
  expect(source.counts().inventories).toBe(0);
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
    expect(source.counts().inventories).toBe(0);
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
  const owner = contentOwnerProof();
  const position = { owner: 'content' as const, dataEpoch: 'content-epoch', sequence: '3' };
  const originalHealth = source.fuseki.commandHealth.bind(source.fuseki);
  source.fuseki.commandHealth = async () => ({ ...await originalHealth(), profiles: {
    'content-match-unit-v1': profileRegistry['content-match-unit-v1'].sha256,
    'content-search-eligibility-v1': profileRegistry['content-search-eligibility-v1'].sha256,
  } });
  const originalQuery = source.fuseki.query.bind(source.fuseki);
  const originalProof = source.fuseki.searchDeltaSince.bind(source.fuseki);
  source.fuseki.searchDeltaSince = async (...args) => ({
    ...await originalProof(...args),
    contentQualification: { population: '1', ownerDataEpoch: position.dataEpoch,
      ownerSequence: position.sequence, publicDomain: false },
  });
  let advanced = false;
  source.fuseki.query = async (sparql: string, maxResponseBytes?: number) => {
    if (sparql.includes('SELECT ?epoch ?sequence ?generation')) {
      if (!advanced) { source.advance(); advanced = true; }
      return originalQuery(sparql, maxResponseBytes);
    }
    if (sparql.includes('SELECT DISTINCT ?resource WHERE') && sparql.includes('rv:searchBody')) {
      return { results: { bindings: [{ resource: uri(work) }] } };
    }
    if (sparql.includes('SELECT DISTINCT ?work ?structure ?occurrence')) {
      return { results: { bindings: [] } };
    }
    if (sparql.includes('?resource ?variant ?revision ?decision ?eligibility ?language')) {
      return { results: { bindings: [{ epoch: binding('epoch'), sequence: binding('8'),
        generation: binding(generation), candidateCount: binding('1'),
        unit: binding('urn:rezics:content:match-unit:one'), score: binding('1'),
        resource: binding(work), variant: binding(owner.variant), revision: binding(owner.revision),
        decision: binding(owner.publication), eligibility: binding(owner.eligibility), language: binding('en'),
        rightsBasis: binding('https://rezics.com/vocab/OriginalContribution') }] } };
    }
    return originalQuery(sparql, maxResponseBytes);
  };
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

test('SEARCH07/SEARCH15/SEARCH18: qualified native writes avoid request-time corpus inventories', async () => {
  const source = fake();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(102);
  source.commitDelta([{ unit: 'urn:rezics:match:old', before: true, after: false },
    { unit: 'urn:rezics:match:new', before: false, after: true }]);
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(102);
  source.commitDelta([{ unit: 'urn:rezics:match:added', before: false, after: true }]);
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(103);
  expect(source.counts()).toEqual({ inventories: 0, deltaCalls: 3,
    healthCalls: 6, queryCalls: 3, controls: 3 });
  expect(source.proofRequests()).toEqual(['-1', '-1', '-1']);
});

test('SEARCH18: an exhausted native qualification can retry without a corpus fallback', async () => {
  const source = fake(10_000);
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  await assertPublicTextReady(source.fuseki, lineage);
  source.commitDelta([{ unit: 'urn:rezics:match:new', before: false, after: true }]);
  const original = source.fuseki.searchDeltaSince.bind(source.fuseki);
  let exhaustOnce = true;
  source.fuseki.searchDeltaSince = async (since: string) => {
    if (exhaustOnce) {
      exhaustOnce = false;
      throw new FusekiReadBudgetExceeded('qualification call exhausted its bounded request');
    }
    return original(since);
  };
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(10_001);
  expect(source.counts()).toMatchObject({ inventories: 0, deltaCalls: 2 });
});

test('SEARCH07/SEARCH10: readiness work stays fixed across corpus and native write sizes', async () => {
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  for (const corpus of [100, 1_000, 10_000, 20_001, 100_000_000]) {
    for (const affected of [1, 8, 64, 65]) {
      const source = fake(corpus);
      expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(corpus);
      source.commitDelta(Array.from({ length: affected }, (_, index) => ({
        unit: `urn:rezics:match:changed-${corpus}-${affected}-${index}`,
        before: true, after: true,
      })));
      expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(corpus);
      expect(source.counts()).toEqual({ inventories: 0, deltaCalls: 2,
        controls: 2, queryCalls: 2, healthCalls: 4 });
      expect(source.proofRequests()).toEqual(['-1', '-1']);
    }
  }
});

test('SEARCH15/SEARCH17/SEARCH18: bypass datasets audit each read while qualified generations never scan', async () => {
  const source = fake();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  await assertPublicTextReady(source.fuseki, lineage);
  source.restart();
  await assertPublicTextReady(source.fuseki, lineage);
  source.changeGeneration();
  await assertPublicTextReady(source.fuseki, lineage);
  expect(source.counts()).toMatchObject({ inventories: 0, deltaCalls: 3 });
  source.disableDelta();
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(102);
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(102);
  expect(source.counts()).toMatchObject({ inventories: 2, deltaCalls: 3 });
  source.breakIndex();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(source.counts().inventories).toBe(3);
});

test('SEARCH15: an unavailable native qualification cannot report a complete result', async () => {
  const source = fake();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  await assertPublicTextReady(source.fuseki, lineage);
  source.commitDelta([{ unit: 'urn:rezics:match:new', before: false, after: true }]);
  source.invalidateNativeProof();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(source.counts().inventories).toBe(0);
  expect(source.counts().deltaCalls).toBe(2);
});

test('SEARCH15: an aborted text write invalidates native qualification until repaired', async () => {
  const source = fake();
  const lineage = { dataEpoch: 'epoch', routingEpoch: 'routing' };
  await assertPublicTextReady(source.fuseki, lineage);
  source.abortIndexWrite();
  await expect(assertPublicTextReady(source.fuseki, lineage))
    .rejects.toBeInstanceOf(SearchIndexUnavailable);
  expect(source.counts().inventories).toBe(0);
  source.commitDelta([{ unit: 'urn:rezics:match:new', before: false, after: true }]);
  expect((await assertPublicTextReady(source.fuseki, lineage)).population).toBe(103);
  expect(source.counts().inventories).toBe(0);
});

test('SEARCH02/SEARCH10: a 513th raw hit cannot become a false complete empty result', async () => {
  const source = fake();
  const env = { fuseki: source.fuseki,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    objectDirectory: '/unused' } as WorkActivationEnvironment;
  await expect(queryPublicMainPhrase(env, { phrase: 'late match', language: 'en' }))
    .rejects.toBeInstanceOf(PublicQueryBudgetExceeded);
  expect(source.counts()).toMatchObject({ inventories: 0, deltaCalls: 1, healthCalls: 3, queryCalls: 2 });
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
  expect(source.counts()).toMatchObject({ inventories: 0, deltaCalls: 1, healthCalls: 3, queryCalls: 2 });
});

test('SEARCH10: batched classification fails closed on a present acceptance slot without a decision', async () => {
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
    await server.stop(true);
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
    await server.stop(true);
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
  expect(performance.now() - started).toBeGreaterThanOrEqual(100);
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
    expect(diagnostics.map(item => [item.phase, item.result])).toEqual([
      ['read', 'snapshot-moved'], ['writer-wait', 'request-timed-out'],
    ]);
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

test('SEARCH18: public search calls forward the decreasing bounded request budget', async () => {
  const originalFetch = globalThis.fetch;
  const remainingBudgets: number[] = [];
  let call = 0;
  globalThis.fetch = (async (_input, init) => {
    const value = new Headers(init?.headers).get('x-rezics-search-budget-ms');
    if (value !== null) remainingBudgets.push(Number(value));
    if (call++ === 0) await Bun.sleep(40);
    return Response.json({ boolean: true });
  }) as typeof fetch;
  try {
    const fuseki = new FusekiClient('http://127.0.0.1:3030/rezics');
    await withStableSearchSnapshot(undefined, async () => {
      await fuseki.query('ASK {}');
      await fuseki.query('ASK {}');
    });
    expect(remainingBudgets).toHaveLength(2);
    expect(remainingBudgets.every(value => Number.isSafeInteger(value) && value >= 1 && value <= 1_500)).toBe(true);
    expect(remainingBudgets[1]).toBeLessThan(remainingBudgets[0]!);
  } finally { globalThis.fetch = originalFetch; }
});

test('SEARCH18: timeout records fixed Fuseki families and their retry phases', async () => {
  const originalFetch = globalThis.fetch;
  let queryCalls = 0;
  let healthCalls = 0;
  let activeSignal: AbortSignal | undefined;
  globalThis.fetch = ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('/query')) {
      queryCalls++;
      if (queryCalls === 2) {
        activeSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          activeSignal?.addEventListener('abort', () => reject(new DOMException('read stopped', 'AbortError')),
            { once: true });
        });
      }
      return Promise.resolve(Response.json({ boolean: true }));
    }
    if (url.searchParams.has('deltaSince')) return Promise.resolve(Response.json({ available: true }));
    if (init?.method === 'POST') return Promise.resolve(Response.json({ results: { bindings: [] } }));
    const active = ++healthCalls === 2;
    return Promise.resolve(Response.json({ moduleVersion: COMMAND_MODULE_VERSION,
      instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: active ? '1' : '0', publicSearchWriteActive: active, profiles: {} }));
  }) as typeof fetch;
  try {
    const fuseki = new FusekiClient('http://127.0.0.1:3030/rezics', undefined, 'a'.repeat(64));
    let timeout: SearchRequestTimedOut | undefined;
    try {
      await withStableSearchSnapshot(fuseki, async () => {
        if (queryCalls > 0) return fuseki.query('SELECT * WHERE { ?s ?p "private query" }');
        await fuseki.query('ASK {}');
        await fuseki.templateQuery({ query: 'SELECT * WHERE {}', bindings: {}, tables: [], limit: 1 });
        await fuseki.searchDeltaSince('0');
        await fuseki.commandHealth();
        throw new SearchSnapshotMoved('position changed');
      }, 300);
    } catch (error) {
      if (error instanceof SearchRequestTimedOut) timeout = error;
      else throw error;
    }
    expect(timeout).toBeInstanceOf(SearchRequestTimedOut);
    expect(activeSignal?.aborted).toBe(true);
    expect(timeout?.diagnostics?.history.map(item => item.family)).toEqual([
      'query', 'template-query', 'delta-proof', 'health', 'health', 'health',
    ]);
    expect(timeout?.diagnostics?.history.at(-1)).toMatchObject({ phase: 'writer-wait', attempt: 1 });
    expect(timeout?.diagnostics?.active).toMatchObject([
      { family: 'query', phase: 'read', attempt: 2, status: 'active' },
    ]);
    expect(JSON.stringify(timeout?.diagnostics)).not.toContain('private query');
  } finally { globalThis.fetch = originalFetch; }
});

test('SEARCH18: timeout diagnostics are bounded, redacted, and retain an aborted active call', async () => {
  const originalFetch = globalThis.fetch;
  const privatePhrase = 'unlogged phrase 9926d511';
  let call = 0;
  let activeSignal: AbortSignal | undefined;
  globalThis.fetch = ((input, init) => {
    const currentCall = call++;
    if (currentCall < 10 || currentCall > 10) return Promise.resolve(Response.json({ boolean: true }));
    activeSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      activeSignal?.addEventListener('abort', () => {
        reject(new DOMException(privatePhrase, 'AbortError'));
      }, { once: true });
    });
  }) as typeof fetch;
  try {
    const fuseki = new FusekiClient('http://127.0.0.1:3030/rezics');
    let timeout: SearchRequestTimedOut | undefined;
    try {
      await withStableSearchSnapshot(undefined, async () => {
        for (let index = 0; index < 10; index++) await fuseki.query('ASK {}');
        await fuseki.query(`SELECT * WHERE { ?s ?p "${privatePhrase}" }`);
      }, 300);
    } catch (error) {
      if (error instanceof SearchRequestTimedOut) timeout = error;
      else throw error;
    }
    expect(timeout).toBeInstanceOf(SearchRequestTimedOut);
    expect(activeSignal?.aborted).toBe(true);
    expect(timeout?.diagnostics?.history).toHaveLength(8);
    expect(timeout?.diagnostics?.omitted).toBe(2);
    expect(timeout?.diagnostics?.active).toHaveLength(1);
    expect(timeout?.diagnostics?.active[0]).toMatchObject({
      family: 'query', attempt: 1, phase: 'read', status: 'active',
    });
    const output = JSON.stringify(timeout?.diagnostics);
    expect(output).not.toContain(privatePhrase);
    expect(output.length).toBeLessThan(2_048);

    await withStableSearchSnapshot(undefined, () => fuseki.query('ASK {}'));
    expect(timeout?.diagnostics?.active).toHaveLength(1);
  } finally { globalThis.fetch = originalFetch; }
});

test('SEARCH18: timeout diagnostics cap simultaneous active Fuseki calls', async () => {
  const originalFetch = globalThis.fetch;
  let started = 0;
  globalThis.fetch = ((_input, init) => {
    started++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('read stopped', 'AbortError')),
        { once: true });
    });
  }) as typeof fetch;
  try {
    const fuseki = new FusekiClient('http://127.0.0.1:3030/rezics');
    let timeout: SearchRequestTimedOut | undefined;
    try {
      await withStableSearchSnapshot(undefined, async () => {
        await Promise.all(Array.from({ length: 10 }, () => fuseki.query('ASK {}')));
      }, 100);
    } catch (error) {
      if (error instanceof SearchRequestTimedOut) timeout = error;
      else throw error;
    }
    expect(started).toBe(10);
    expect(timeout).toBeInstanceOf(SearchRequestTimedOut);
    expect(timeout?.diagnostics?.history).toHaveLength(0);
    expect(timeout?.diagnostics?.active).toHaveLength(8);
    expect(timeout?.diagnostics?.active.every(item => item.family === 'query'
      && item.phase === 'read' && item.status === 'active')).toBe(true);
    expect(timeout?.diagnostics?.omitted).toBe(2);
  } finally { globalThis.fetch = originalFetch; }
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
