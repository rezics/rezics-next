import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import { RV } from '../src/modules/work/activate.ts';

const graphEpoch = 'graph-epoch', contentEpoch = 'content-epoch';
const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const resource = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';
const matchUnit = 'urn:rezics:match:retained-private-result';
const binding = (value: string) => ({ type: 'literal', value });
const contentPosition = () => ({ owner: 'content' as const, dataEpoch: contentEpoch, sequence: '2' });

/** Keeps the native projection, source and cursor coherent so only Access closes the route. */
class SearchGraph extends FusekiClient {
  matched = false;
  constructor() { super('http://search-custody.invalid'); }
  override async commandHealth() {
    return { moduleVersion: 'test', instanceId: '11111111-1111-4111-8111-111111111111',
      publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
      profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) };
  }
  override async query(query: string): Promise<SparqlResult> {
    if (query.includes('ASK {')) return { boolean: true };
    if (query.includes('SELECT ?generation WHERE') && query.includes('"occurrence-lucene-v1"')) {
      return { results: { bindings: [] } };
    }
    if (query.includes('?probeScore')) return { results: { bindings: [{
      epoch: binding(graphEpoch), sequence: binding('7'), generation: binding(generation), population: binding('1'),
    }] } };
    if (query.includes('rv:publicTextInventory()')) return { results: { bindings: [{ population: binding('1') }] } };
    if (query.includes('SELECT ?epoch ?sequence ?generation ?declared')) return { results: { bindings: [{
      epoch: binding(graphEpoch), sequence: binding('7'), generation: binding(generation),
      declared: binding('1'), heads: binding('1'), missing: binding('0'), eligible: binding('1'), contentUnits: binding('1'),
    }] } };
    if (query.includes('?candidateCount')) {
      this.matched = true;
      return { results: { bindings: [{ epoch: binding(graphEpoch), sequence: binding('7'),
        generation: binding(generation), candidateCount: binding('1'), unit: binding(matchUnit), score: binding('2.5'),
        resource: binding(resource), variant: binding('urn:rezics:variant:33333333-3333-4333-8333-333333333333'),
        revision: binding('urn:rezics:content:revision:44444444-4444-4444-8444-444444444444'),
        decision: binding('urn:rezics:decision:1'), language: binding('en'),
        eligibility: binding('urn:rezics:content:eligibility:1'), rightsBasis: binding(`${RV}OriginalContribution`),
      }] } };
    }
    throw new Error(`unexpected search custody query: ${query.slice(0, 80)}`);
  }
}

function fixture() {
  const graph = new SearchGraph();
  const state = { held: false, sourceReads: 0, closeAfterMatch: false, closeOnSource: false };
  const content = { ownerPosition: async () => {
    state.sourceReads++;
    if (state.closeOnSource || state.closeAfterMatch && graph.matched) state.held = true;
    return contentPosition();
  } } as unknown as ContentCore;
  const cursor = { read: async () => contentPosition() } as unknown as ContentProjectionCursor;
  const deps = { environment: { fuseki: graph, objectDirectory: '.temp/erasure-custody-tests',
    lineage: { dataEpoch: graphEpoch, routingEpoch: '1' } },
  access: { assertRecoveryOpen: async () => {
    if (state.held) throw new AdmissionUnavailable('Access is held for recovery');
  } }, contentProjection: { content, cursor, consumer: 'public-search' } } as unknown as MainWorkDependencies;
  const app = createMainApp(graph, deps);
  const search = () => app.handle(new Request('http://main.local/v1/queries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'public-content-phrase-v1', phrase: 'needle', language: null }),
  }));
  const ready = () => app.handle(new Request('http://main.local/health/search-ready'));
  return { graph, state, search, ready };
}

test('OPS12: coherent Content phrase search and readiness open only with Access recovery custody', async () => {
  const f = fixture();
  const response = await f.search();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ profile: 'public-content-phrase-v1',
    results: [{ matchUnit }], graphPosition: { dataEpoch: graphEpoch, sequence: '7' } });
  expect((await f.ready()).status).toBe(200);
});

test('OPS12: a held Access owner refuses Content phrase and search-ready before source reads', async () => {
  const f = fixture();
  f.state.held = true;
  const response = await f.search();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(matchUnit);
  expect((await f.ready()).status).toBe(503);
  expect(f.state.sourceReads).toBe(0);
  expect(f.graph.matched).toBe(false);
});

test('OPS12: Access closure during the matched Content projection fence withholds the completed search result', async () => {
  const f = fixture();
  f.state.closeAfterMatch = true;
  const response = await f.search();
  expect(f.graph.matched).toBe(true);
  expect(f.state.sourceReads).toBeGreaterThan(1);
  expect(f.state.held).toBe(true);
  expect(response.status).toBe(503);
  const result = await response.text();
  expect(result).not.toContain(matchUnit);
  expect(result).not.toContain('graphPosition');
});

test('OPS12: search-ready withholds its ready proof if Access closes during source lookup', async () => {
  const f = fixture();
  f.state.closeOnSource = true;
  const response = await f.ready();
  expect(f.state.sourceReads).toBeGreaterThan(0);
  expect(f.state.held).toBe(true);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: 'unavailable' });
});
