import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { checkProductionEnv } from '../../../scripts/ops/production-env.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { relayContentProjectionOnce } from '../src/modules/content-publication/relay.ts';
import { CONTENT_REBUILD_NONEMPTY_REFUSAL, CONTENT_REBUILD_PAGE, SEARCH_REBUILD_CRASH_AT,
  SEARCH_REBUILD_CRASH_FLAG, SEARCH_REBUILD_CRASH_POINTS, SearchRebuildCrash,
  contentRebuildClearPageQuery, crashSearchRebuild, nextContentRebuildStep,
  readContentRebuildProgress, type ContentRebuildProgress }
  from '../src/modules/content-publication/rebuild.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const epoch = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const job = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generation = 'urn:rezics:text-index-generation:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const digest = 'd'.repeat(64);
const term = (value: string) => ({ type: 'literal', value });

interface Scene {
  anchor: boolean;
  quarantine: boolean;
  clearReceipt: boolean;
  contentUnits: boolean;
  malformed: boolean;
  /** Receipt sequence equal to control sequence means the pass still covers the graph. */
  offlineSequence?: string;
  activation?: string;
  replay: string;
  cut: string;
  sequence?: string;
  generation?: string;
}

async function progress(scene: Scene): Promise<ContentRebuildProgress> {
  const fuseki = { async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('rv:indexRebuildDigest')) {
      return { results: { bindings: scene.offlineSequence ? [{
        digest: term(digest), sequence: term(scene.offlineSequence) }] : [] } };
    }
    if (sparql.includes('content-rebuild:activate')) {
      return { results: { bindings: scene.activation ? [{ generation: term(scene.activation) }] : [] } };
    }
    if (sparql.includes('rv:ownerDataEpoch')) {
      return { results: { bindings: scene.quarantine ? [{
        epoch: term(epoch), sequence: term('4'),
        sourceEpoch: term(epoch), sourceSequence: term(scene.cut) }] : [] } };
    }
    if (sparql.includes('rv:textIndexGeneration ?generation')) {
      return { results: { bindings: [{
        sequence: term(scene.sequence ?? '10'),
        generation: term(scene.generation ?? generation) }] } };
    }
    if (sparql.includes('FILTER NOT EXISTS') && sparql.includes('content:match-unit')) {
      return { boolean: scene.malformed };
    }
    if (sparql.includes('SearchGraphAnchor')) return { boolean: scene.anchor };
    if (sparql.includes('content-rebuild:cleared')) return { boolean: scene.clearReceipt };
    if (sparql.includes('content:projection')) return { boolean: scene.contentUnits };
    throw new Error(`unexpected rebuild query: ${sparql.slice(0, 180)}`);
  } } as unknown as WorkActivationEnvironment['fuseki'];
  return readContentRebuildProgress({ fuseki, lineage: { dataEpoch: epoch, routingEpoch: epoch },
    objectDirectory: '' }, job, scene.replay);
}

const closed = { anchor: false, quarantine: true, clearReceipt: true, contentUnits: false,
  malformed: false, replay: '0', cut: '5' };

test('a quarantined rebuild resumes from every stored state', async () => {
  const step = async (scene: Scene) => nextContentRebuildStep(await progress(scene));
  expect(await step({ ...closed, anchor: true, quarantine: false, clearReceipt: false })).toBe('quarantine');
  expect(await step({ ...closed, clearReceipt: false, contentUnits: true })).toBe('clear');
  // Units came back after the terminal clear. The graph is closed, so this is another clear.
  expect(await step({ ...closed, contentUnits: true, generation: generation })).toBe('clear');
  expect(await step(closed)).toBe('offline');
  expect(await step({ ...closed, offlineSequence: '9' })).toBe('offline');
  expect(await step({ ...closed, offlineSequence: '10' })).toBe('replay');
  expect(await step({ ...closed, replay: '2', contentUnits: true })).toBe('replay');
  expect(await step({ ...closed, replay: '5', contentUnits: true, offlineSequence: '8' })).toBe('activate');
  expect(await step({ ...closed, replay: '0', cut: '0', clearReceipt: false })).toBe('clear');
  expect(await step({ ...closed, replay: '0', cut: '0', offlineSequence: '10' })).toBe('activate');
  expect(await step({ ...closed, activation: generation, anchor: true })).toBe('done');
  expect(await step({ ...closed, malformed: true })).toEqual({ refuse: CONTENT_REBUILD_NONEMPTY_REFUSAL });
  expect(await step({ ...closed, anchor: false, quarantine: false, clearReceipt: false }))
    .toEqual({ refuse: 'quarantine: anchor is absent and this job has no receipt' });
  expect(await step({ ...closed, anchor: true })).toEqual({ refuse: 'quarantine: anchor returned before activation' });
  expect(await step({ ...closed, activation: generation, anchor: false }))
    .toEqual({ refuse: 'activate: anchor is absent after activation' });
});

test('Content clear pages are ordered and stay inside the native subject cap', () => {
  const query = contentRebuildClearPageQuery();
  expect(CONTENT_REBUILD_PAGE).toBe(64);
  expect(query).toContain('ORDER BY STR(?unit)');
  expect(query).toContain(`LIMIT ${CONTENT_REBUILD_PAGE}`);
});

test('the search rebuild crash seam is inert unless a test arms it', () => {
  expect(SEARCH_REBUILD_CRASH_POINTS).toEqual([
    'after-quarantine', 'after-clear', 'after-offline-index', 'after-replay', 'before-activation']);
  const previousFlag = process.env[SEARCH_REBUILD_CRASH_FLAG];
  const previousAt = process.env[SEARCH_REBUILD_CRASH_AT];
  const previousNode = process.env.NODE_ENV;
  try {
    delete process.env[SEARCH_REBUILD_CRASH_FLAG];
    delete process.env[SEARCH_REBUILD_CRASH_AT];
    expect(() => crashSearchRebuild('after-quarantine')).not.toThrow();
    process.env[SEARCH_REBUILD_CRASH_FLAG] = '1';
    process.env[SEARCH_REBUILD_CRASH_AT] = 'after-clear';
    process.env.NODE_ENV = 'production';
    expect(() => crashSearchRebuild('after-clear')).not.toThrow();
    process.env.NODE_ENV = 'test';
    expect(() => crashSearchRebuild('after-quarantine')).not.toThrow();
    expect(() => crashSearchRebuild('after-clear')).toThrow(SearchRebuildCrash);
  } finally {
    if (previousFlag === undefined) delete process.env[SEARCH_REBUILD_CRASH_FLAG];
    else process.env[SEARCH_REBUILD_CRASH_FLAG] = previousFlag;
    if (previousAt === undefined) delete process.env[SEARCH_REBUILD_CRASH_AT];
    else process.env[SEARCH_REBUILD_CRASH_AT] = previousAt;
    if (previousNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNode;
  }
});

test('production preflight rejects the search rebuild crash seam', () => {
  expect(() => checkProductionEnv({ [SEARCH_REBUILD_CRASH_FLAG]: '1' }, [])).toThrow(
    'Production forbids REZICS_QA_SEARCH_REBUILD_CRASH');
  expect(() => checkProductionEnv({ [SEARCH_REBUILD_CRASH_AT]: 'after-quarantine' }, [])).toThrow(
    'Production forbids REZICS_QA_SEARCH_REBUILD_CRASH_AT');
  try { checkProductionEnv({}, []); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(SEARCH_REBUILD_CRASH_FLAG);
  }
});

test('public projection waits while the search anchor is absent', async () => {
  let queries = 0;
  const fuseki = { async query(sparql: string): Promise<SparqlResult> {
    queries++;
    expect(sparql).toContain('SearchGraphAnchor');
    return { boolean: false };
  } } as unknown as WorkActivationEnvironment['fuseki'];
  const env = { fuseki, lineage: { dataEpoch: epoch, routingEpoch: epoch }, objectDirectory: '' };
  const cursor = { retries: () => { throw new Error('cursor read'); } } as unknown as ContentProjectionCursor;
  expect(await relayContentProjectionOnce(env, {} as ContentCore, cursor, 'main-content-public-search-v1')).toBeNull();
  expect(queries).toBe(1);
  const replaying = { retries: async () => [], readScan: async () => { throw new Error('replay continued'); } };
  await expect(relayContentProjectionOnce(env, {} as ContentCore,
    replaying as unknown as ContentProjectionCursor, 'main-content-public-search-v1', job))
    .rejects.toThrow('replay continued');
  expect(queries).toBe(1);
});
