import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { ContentProjectionWorker } from '../src/content-projection-worker.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';

const graphEpoch = 'graph-epoch';
const contentEpoch = 'content-epoch';
const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const contentPosition = (sequence: string) => ({ owner: 'content' as const,
  dataEpoch: contentEpoch, sequence });
const binding = (value: string) => ({ type: 'literal', value });

class SearchFuseki extends FusekiClient {
  available = true;
  missing = false;
  constructor() { super('http://127.0.0.1:1/rezics'); }
  override async commandHealth() {
    return { moduleVersion: 'test', instanceId: '11111111-1111-4111-8111-111111111111',
      profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([id, profile]) => [id, profile.sha256])) };
  }
  override async query(sparql: string): Promise<SparqlResult> {
    if (!this.available) throw new Error('graph unavailable');
    if (sparql.includes('ASK {')) return { boolean: true };
    if (sparql.includes('?probeScore')) {
      return { results: { bindings: [{ epoch: binding(graphEpoch), sequence: binding('7'),
        generation: binding(generation) }] } };
    }
    if (sparql.includes('SELECT ?epoch ?sequence ?generation ?population')) {
      return { results: { bindings: [{ epoch: binding(graphEpoch), sequence: binding('7'),
        generation: binding(generation), population: binding('1'), indexed: binding('1'),
        uniqueIndexed: binding('1'), valid: binding('1') }] } };
    }
    if (sparql.includes('SELECT ?epoch ?sequence ?generation ?declared')) {
      return { results: { bindings: [{ epoch: binding(graphEpoch), sequence: binding('7'),
        generation: binding(generation), declared: binding('1'), heads: binding('1'),
        missing: binding(this.missing ? '1' : '0'), eligible: binding('1'), contentUnits: binding('1'),
      }] } };
    }
    if (sparql.includes('?candidateCount')) {
      const match = sparql.includes('needle');
      return { results: { bindings: [{ epoch: binding(graphEpoch), sequence: binding('7'),
        generation: binding(generation), candidateCount: binding(match ? '1' : '0'),
        ...(match ? { unit: binding('urn:rezics:match:1'), score: binding('2.5'),
          resource: binding('https://rezics.com/id/11111111-1111-4111-8111-111111111111'),
          variant: binding('urn:rezics:variant:1'), revision: binding('urn:rezics:content:revision:1'),
          decision: binding('urn:rezics:decision:1'), language: binding('en') } : {}) }] } };
    }
    throw new Error(`unexpected query: ${sparql.slice(0, 80)}`);
  }
}

function fixture() {
  const fuseki = new SearchFuseki();
  let source = '2';
  let checkpoint = '2';
  const content = { ownerPosition: async () => contentPosition(source) } as ContentCore;
  const cursor = { read: async () => contentPosition(checkpoint) } as unknown as ContentProjectionCursor;
  const app = createMainApp(fuseki, { environment: {
    fuseki, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' }, objectDirectory: '.temp/unused',
  }, contentProjection: { content, cursor, consumer: 'public-search' } } as unknown as MainWorkDependencies);
  const search = (phrase: string, language: string | null = null) => app.handle(new Request('http://localhost/v1/queries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'public-content-phrase-v1', phrase, language }),
  }));
  const readiness = () => app.handle(new Request('http://localhost/health/search-ready'));
  return { fuseki, search, readiness, setSource: (value: string) => { source = value; },
    setCheckpoint: (value: string) => { checkpoint = value; } };
}

test('SEARCH19: Content phrase route returns a typed complete result at both source positions', async () => {
  const run = fixture();
  const response = await run.search('needle');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ contractVersion: '1',
    profile: 'public-content-phrase-v1', resultGrain: 'content-variant', complete: true,
    total: 1, population: 1, graphPosition: { dataEpoch: graphEpoch, sequence: '7' },
    contentPosition: contentPosition('2'), indexGeneration: generation,
    results: [{ matchUnit: 'urn:rezics:match:1', score: 2.5 }] });
  expect((await run.readiness()).status).toBe(200);
});

test('SEARCH19: Content route and readiness fail closed on lag and graph outage', async () => {
  const run = fixture();
  run.setCheckpoint('1');
  const lagged = await run.search('needle');
  expect(lagged.status).toBe(503);
  expect((await lagged.json() as { code: string }).code).toBe('content_projection_unavailable');
  expect((await run.readiness()).status).toBe(503);
  run.setCheckpoint('2');
  run.fuseki.missing = true;
  expect((await run.search('needle')).status).toBe(503);
  expect((await run.readiness()).status).toBe(503);
  run.fuseki.missing = false;
  run.fuseki.available = false;
  expect((await run.search('needle')).status).toBe(503);
  expect((await run.readiness()).status).toBe(503);
  run.fuseki.available = true;
  expect((await run.search('x')).status).toBe(400);
  run.setSource('3');
  expect((await run.search('needle')).status).toBe(503);
});

test('SEARCH19/OPS16: worker retries a failed poll and restarted instance resumes its checkpoint', async () => {
  let checkpoint = 0;
  let attempts = 0;
  const errors: unknown[] = [];
  let completed!: () => void;
  const firstProgress = new Promise<void>(resolve => { completed = resolve; });
  const poll = async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary graph failure');
    if (checkpoint === 0) {
      checkpoint = 1;
      completed();
      return { sourceEpoch: contentEpoch, sourceSequence: '1' as const, disposition: 'ignored' as const };
    }
    return null;
  };
  const worker = new ContentProjectionWorker(poll, 100, error => errors.push(error));
  worker.start();
  try { await firstProgress; }
  finally { await worker.stop(); }
  expect(errors).toHaveLength(1);
  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(checkpoint).toBe(1);
  const restarted = new ContentProjectionWorker(async () => {
    const next = ++checkpoint;
    return { sourceEpoch: contentEpoch, sourceSequence: String(next), disposition: 'ignored' };
  });
  expect((await restarted.pollOnce())?.sourceSequence).toBe('2');
  expect(checkpoint).toBe(2);
});
