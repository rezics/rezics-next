import { expect, test } from 'bun:test';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type SearchDeltaProof } from '../src/infrastructure/fuseki.ts';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { assertPublicContentSearchReady } from '../src/modules/content-publication/search.ts';
import { ContentProjectionUnavailable } from '../src/modules/content-publication/relay.ts';
import { SearchIndexUnavailable, SearchReadinessPending, SearchRequestTimedOut, SearchSnapshotMoved,
  withStableSearchSnapshot } from '../src/modules/work/search-readiness.ts';
import { withSearchGraphSnapshot } from '../src/modules/search/snapshot.ts';
import { searchOperationEvidence, type SearchPhaseEvidence } from '../src/modules/search/operation-evidence.ts';

const lineage = { dataEpoch: 'graph-epoch', routingEpoch: 'routing' };
const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const term = (value: string) => ({ type: 'literal', value });
const witness = { population: '2', ownerDataEpoch: 'content-epoch', ownerSequence: '8', publicDomain: false };

function fixture() {
  const fuseki = new FusekiClient('http://unused.invalid');
  const queries: string[] = [];
  let sequence = '25', writeEpoch = '2', sourceReads = 0, proofReads = 0;
  let qualification: unknown = witness;
  let source = { dataEpoch: 'content-epoch', sequence: '10' };
  let checkpoint = { ...source };
  let afterSource: typeof source | undefined;
  let nativeReady = true;
  const profiles: Record<string, string> = Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256]));
  fuseki.commandHealth = async () => ({ moduleVersion: 'test', profiles,
    instanceId: '11111111-1111-4111-8111-111111111111',
    publicSearchWriteEpoch: writeEpoch, publicSearchWriteActive: false, publicSearchDeltaAvailable: true });
  fuseki.query = async sparql => {
    queries.push(sparql);
    if (sparql.includes('ASK')) return { boolean: true };
    if (!sparql.includes('textIndexProfile') && !sparql.includes('SELECT ?epoch ?sequence ?generation')) {
      throw new Error('foreground population query');
    }
    return { results: { bindings: [{ epoch: term(lineage.dataEpoch), sequence: term(sequence),
      generation: term(generation) }] } };
  };
  fuseki.searchDeltaSince = async (): Promise<SearchDeltaProof> => {
    proofReads++;
    if (!nativeReady) return { available: false };
    return { available: true, ordinal: '1', dataEpoch: lineage.dataEpoch, sequence, generation,
      writeEpoch, luceneGeneration: '3', qualifiedPopulation: '9', deltas: [],
      contentQualification: qualification } as SearchDeltaProof;
  };
  const content = { ownerPosition: async () => {
    sourceReads++;
    return sourceReads > 1 && afterSource ? afterSource : source;
  } } as ContentCore;
  const cursor = { read: async () => checkpoint } as unknown as ContentProjectionCursor;
  const env = { fuseki, lineage, objectDirectory: '.temp/content-readiness' };
  return { env, fuseki, queries, profiles,
    read: () => assertPublicContentSearchReady(env, content, cursor, 'content-test'),
    moveGraph: () => { sequence = String(Number(sequence) + 1); writeEpoch = String(Number(writeEpoch) + 2); },
    qualification: (value: unknown) => { qualification = value; },
    source: (value: typeof source) => { source = value; checkpoint = { ...value }; },
    checkpoint: (value: typeof source) => { checkpoint = value; },
    afterSource: (value: typeof source) => { afterSource = value; },
    cold: () => { nativeReady = false; },
    proofs: () => proofReads };
}

test('cold and warm Content readiness consume bounded native witnesses across graph advances', async () => {
  const f = fixture();
  for (let index = 0; index < 3; index++) {
    expect(await f.read()).toMatchObject({ contentPosition: { dataEpoch: 'content-epoch', sequence: '10' },
      index: { contentQualification: { population: 2 }, sequence: String(25 + index) } });
    f.moveGraph();
  }
  expect(f.proofs()).toBe(3);
  expect(f.queries).toHaveLength(6);
});

test.each([undefined, null, {}, { ...witness, population: '-1' },
  { ...witness, ownerSequence: '01' }, { ...witness, publicDomain: 'false' },
  { population: '2', ownerSequence: '0', publicDomain: false }])(
  'missing or malformed Content witnesses stay pending without auditing: %j', async value => {
    const f = fixture();
    f.qualification(value);
    await expect(f.read()).rejects.toBeInstanceOf(SearchReadinessPending);
  });

test.each([{ ...witness, population: '10' }, { ...witness, ownerDataEpoch: 'foreign' },
  { ...witness, ownerSequence: '11' }])(
  'out-of-cut Content qualifications refuse without auditing: %j', async value => {
    const f = fixture();
    f.qualification(value);
    await expect(f.read()).rejects.toBeInstanceOf(ContentProjectionUnavailable);
  });

test('only an explicit qualified empty inventory permits a Content owner without publications', async () => {
  const f = fixture();
  f.qualification({ population: '0', ownerSequence: '0', publicDomain: false });
  expect((await f.read()).index.contentQualification?.population).toBe(0);
});

test('a never-qualified native generation remains a cold readiness failure', async () => {
  const f = fixture();
  f.cold();
  // The anchored control probe distinguishes missing evidence from movement.
  f.fuseki.query = async sparql => sparql.includes('ASK') ? { boolean: true }
    : { results: { bindings: [{ epoch: term(lineage.dataEpoch), sequence: term('25'), generation: term(generation) }] } };
  await expect(f.read()).rejects.toBeInstanceOf(SearchIndexUnavailable);
});

test('Content source checkpoint lag and movement retain distinct unavailable and retryable outcomes', async () => {
  const lag = fixture();
  lag.checkpoint({ dataEpoch: 'content-epoch', sequence: '9' });
  await expect(lag.read()).rejects.toBeInstanceOf(SearchReadinessPending);
  expect(lag.proofs()).toBe(0);
  const moved = fixture();
  moved.afterSource({ dataEpoch: 'content-epoch', sequence: '11' });
  await expect(moved.read()).rejects.toBeInstanceOf(SearchSnapshotMoved);
});

test('one bounded search recaptures its graph after Content delivery and background qualification', async () => {
  const f = fixture();
  f.checkpoint({ dataEpoch: 'content-epoch', sequence: '9' });
  let attempts = 0;
  const diagnostics: import('../src/modules/work/search-readiness.ts').SearchAttemptDiagnostic[] = [];
  const result = await withStableSearchSnapshot(f.fuseki, () => {
    attempts++;
    if (attempts === 2) {
      f.source({ dataEpoch: 'content-epoch', sequence: '11' });
      f.moveGraph();
      f.qualification(undefined);
    }
    if (attempts === 3) {
      f.moveGraph();
      f.qualification({ ...witness, population: '3', ownerSequence: '11' });
    }
    return withSearchGraphSnapshot(f.env, f.read);
  }, undefined, diagnostics);
  expect(attempts).toBe(3);
  expect(result).toMatchObject({ contentPosition: { dataEpoch: 'content-epoch', sequence: '11' },
    index: { sequence: '27', contentQualification: { population: 3, ownerSequence: '11' } } });
  expect(diagnostics.map(attempt => attempt.result)).toEqual(['readiness-pending', 'readiness-pending']);
  expect(f.queries.some(query => /COUNT|publicTextInventory|ContentVariant/.test(query))).toBe(false);
});

test('pending projection or qualification exhausts the same wall deadline without becoming an empty page', async () => {
  for (const phase of ['projection', 'qualification']) {
    const f = fixture();
    if (phase === 'projection') f.checkpoint({ dataEpoch: 'content-epoch', sequence: '9' });
    else f.qualification(undefined);
    let attempts = 0;
    const phases: SearchPhaseEvidence[] = [];
    await expect(searchOperationEvidence.run({ phases }, () => withStableSearchSnapshot(f.fuseki,
      () => { attempts++; return f.read(); }, 220))).rejects.toBeInstanceOf(SearchRequestTimedOut);
    expect(attempts).toBeGreaterThan(1);
    expect(phases.some(entry => entry.phase === 'readiness-owner-wait')).toBe(true);
    expect(f.queries.some(query => /COUNT|publicTextInventory|ContentVariant/.test(query))).toBe(false);
  }
});

test('foreign or future checkpoints and out-of-cut witnesses do not retry as pending delivery', async () => {
  const foreign = fixture();
  foreign.checkpoint({ dataEpoch: 'foreign', sequence: '9' });
  const future = fixture();
  future.checkpoint({ dataEpoch: 'content-epoch', sequence: '11' });
  const unqualified = fixture();
  unqualified.qualification({ ...witness, ownerDataEpoch: 'foreign' });
  for (const f of [foreign, future, unqualified]) {
    let attempts = 0;
    await expect(withStableSearchSnapshot(f.fuseki, () => { attempts++; return f.read(); }))
      .rejects.toBeInstanceOf(ContentProjectionUnavailable);
    expect(attempts).toBe(1);
  }
});

test('public-domain generations require their retained eligibility profile before matching', async () => {
  const f = fixture();
  f.qualification({ ...witness, publicDomain: true });
  expect(await f.read()).toBeDefined();
  delete f.profiles['content-search-eligibility-v2'];
  await expect(f.read()).rejects.toThrow('Fuseki Content search profiles differ');
});

test('Content qualification timeouts retain the shared deadline and active phase', async () => {
  const f = fixture();
  f.fuseki.searchDeltaSince = async () => new Promise<never>(() => {});
  const phases: SearchPhaseEvidence[] = [];
  await expect(searchOperationEvidence.run({ phases }, () => withStableSearchSnapshot(f.fuseki, f.read, 30)))
    .rejects.toBeInstanceOf(SearchRequestTimedOut);
  expect(phases.find(phase => phase.phase === 'readiness-qualified-checkpoint')?.state).toBe('active');
});
