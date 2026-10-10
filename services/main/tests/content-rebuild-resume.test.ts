import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { checkProductionEnv } from '../../../scripts/ops/production-env.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { relayContentProjectionOnce } from '../src/modules/content-publication/relay.ts';
import { CONTENT_REBUILD_NONEMPTY_REFUSAL, CONTENT_REBUILD_PAGE, SEARCH_REBUILD_CRASH_AT,
  SEARCH_REBUILD_CRASH_FLAG, SEARCH_REBUILD_CRASH_POINTS, SearchRebuildCrash,
  contentRebuildClearPageQuery, crashSearchRebuild, freshJobLine, nextContentRebuildStep,
  quarantinePublicContentSearch, readAdoptedQuarantineJob, readContentRebuildProgress,
  repeatedFreshJobRefusal, type ContentRebuildProgress }
  from '../src/modules/content-publication/rebuild.ts';
import { DATASET, hash, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

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
      return { results: { bindings: scene.malformed ? [{ unit: term('urn:rezics:content:match-unit:bad') }] : [] } };
    }
    if (sparql.includes('SearchGraphAnchor')) return { boolean: scene.anchor };
    if (sparql.includes('content-rebuild:cleared')) return { boolean: scene.clearReceipt };
    if (sparql.includes('content:projection')) {
      return { results: { bindings: scene.contentUnits ? [{ unit: term('urn:rezics:content:match-unit:ok') }] : [] } };
    }
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
  expect(await step({ ...closed, replay: '2', contentUnits: true, offlineSequence: '8' })).toBe('replay');
  expect(await step({ ...closed, replay: '2', contentUnits: true })).toEqual({ restart: 'fresh-job' });
  expect(await step({ ...closed, replay: '5', contentUnits: true })).toEqual({ restart: 'fresh-job' });
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

const prior = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const fresh = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function committed(sequence = '11') {
  return { status: 'committed' as const, position: { datasetId: DATASET, dataEpoch: epoch, sequence } };
}

function anchorDeleted(update: string): boolean {
  return (update.split('} WHERE {')[0] ?? '').includes('SearchGraphAnchor');
}

test('a second fresh-job restart names both ids and stops', () => {
  expect(freshJobLine(fresh, job)).toBe(
    `content-rebuild step: fresh job ${fresh} (previous job ${job} had no offline evidence)`);
  const refusal = repeatedFreshJobRefusal(job, fresh);
  expect(refusal).toContain(job);
  expect(refusal).toContain(fresh);
  expect(refusal).toBe(`content-rebuild: fresh job refused for ${job} and ${fresh}`);
});

test('a job with an activation receipt is never adopted', async () => {
  const queries: string[] = [];
  const fuseki = { async query(sparql: string): Promise<SparqlResult> {
    queries.push(sparql);
    if (sparql.includes('rv:rebuildJob ?job')) {
      return { results: { bindings: [{ job: term(job) }] } };
    }
    if (sparql.includes('content-rebuild:activate')) {
      return { results: { bindings: [{ generation: term(generation) }] } };
    }
    throw new Error(`unexpected adopt query: ${sparql.slice(0, 180)}`);
  }, async commandWithReceipt() {
    throw new Error('adopt must not write');
  } } as unknown as WorkActivationEnvironment['fuseki'];
  const env = { fuseki, lineage: { dataEpoch: epoch, routingEpoch: epoch }, objectDirectory: '' };
  expect(await readAdoptedQuarantineJob(env)).toBeNull();
  const content = { ownerPosition: async () => ({ owner: 'content' as const, dataEpoch: epoch, sequence: '5' }) };
  await expect(quarantinePublicContentSearch(env, content as unknown as ContentCore, job))
    .rejects.toThrow('quarantine: a job with an activation receipt is never adopted');
  expect(queries.some(sparql => sparql.includes('command'))).toBe(false);
});

test('an existing live anchor still takes the quarantine deletion path', async () => {
  let quarantineReads = 0;
  let anchor = true;
  const updates: string[] = [];
  const fuseki = { async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('content-rebuild:activate')) return { results: { bindings: [] } };
    if (sparql.includes('rv:ownerDataEpoch')) {
      quarantineReads++;
      if (quarantineReads === 1) return { results: { bindings: [] } };
      return { results: { bindings: [{ epoch: term(epoch), sequence: term('4'),
        sourceEpoch: term(epoch), sourceSequence: term('5') }] } };
    }
    if (sparql.includes('SearchGraphAnchor')) return { boolean: anchor };
    if (sparql.includes('content-rebuild:profile')) return { boolean: true };
    throw new Error(`unexpected quarantine query: ${sparql.slice(0, 180)}`);
  }, async commandWithReceipt(envelope: { update: string }) {
    updates.push(envelope.update);
    anchor = false;
    return committed();
  } } as unknown as WorkActivationEnvironment['fuseki'];
  const env = { fuseki, lineage: { dataEpoch: epoch, routingEpoch: epoch }, objectDirectory: '' };
  const content = { ownerPosition: async () => ({ owner: 'content' as const, dataEpoch: epoch, sequence: '5' }) };
  const result = await quarantinePublicContentSearch(env, content as unknown as ContentCore, fresh);
  expect(result).toMatchObject({ id: fresh, cut: { owner: 'content', dataEpoch: epoch, sequence: '5' } });
  expect(updates).toHaveLength(1);
  expect(anchorDeleted(updates[0]!)).toBe(true);
  expect(updates[0]).not.toContain('FILTER NOT EXISTS { GRAPH <urn:rezics:search:public>');
});

test('a new id continues an open quarantine without deleting the absent anchor', async () => {
  let wrote = false;
  const updates: string[] = [];
  const priorReceipt = `urn:rezics:receipt:content-rebuild:quarantine:${hash(prior)}`;
  const fuseki = { async query(sparql: string): Promise<SparqlResult> {
    if (sparql.includes('content-rebuild:activate')) return { results: { bindings: [] } };
    if (sparql.includes('rv:ownerDataEpoch')) {
      const visible = sparql.includes(priorReceipt) || wrote;
      if (!visible) return { results: { bindings: [] } };
      return { results: { bindings: [{ epoch: term(epoch), sequence: term('4'),
        sourceEpoch: term(epoch), sourceSequence: term('5') }] } };
    }
    if (sparql.includes('SearchGraphAnchor')) return { boolean: false };
    if (sparql.includes('content-rebuild:profile')) return { boolean: true };
    throw new Error(`unexpected fresh quarantine query: ${sparql.slice(0, 180)}`);
  }, async commandWithReceipt(envelope: { update: string }) {
    updates.push(envelope.update);
    wrote = true;
    return committed();
  } } as unknown as WorkActivationEnvironment['fuseki'];
  const env = { fuseki, lineage: { dataEpoch: epoch, routingEpoch: epoch }, objectDirectory: '' };
  const content = { ownerPosition: async () => ({ owner: 'content' as const, dataEpoch: epoch, sequence: '5' }) };
  const result = await quarantinePublicContentSearch(env, content as unknown as ContentCore, fresh, prior);
  expect(result.cut).toEqual({ owner: 'content', dataEpoch: epoch, sequence: '5' });
  expect(updates).toHaveLength(1);
  expect(anchorDeleted(updates[0]!)).toBe(false);
  expect(updates[0]).toContain('FILTER NOT EXISTS');
  expect(updates[0]).toContain(priorReceipt);
  // A quarantine receipt from before rv:rebuildJob existed carries only its
  // outcome, epoch and sequence; the continuing guard must accept it.
  const clause = updates[0]!.slice(updates[0]!.indexOf(`<${priorReceipt}>`)).split('. }')[0]!;
  expect(clause).toContain('rv:sequence ?priorSequence');
  expect(clause).not.toContain('rv:rebuildJob');
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
