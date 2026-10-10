import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { SEARCH_REBUILD_CRASH_AT, SEARCH_REBUILD_CRASH_FLAG, SEARCH_REBUILD_CRASH_POINTS,
  type SearchRebuildCrashPoint } from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { querySearchFields } from '../../../services/main/src/modules/search/fields.ts';
import { DATASET, GRAPHS, PUBLIC_SEARCH_ANCHOR, RV, initializeFreshGraph, iri }
  from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady } from '../../../services/main/src/modules/work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { seedRecoveryContent } from './search-content-fixture.ts';
import { lastJson, migrateAccess, qaStack, refusedRootCommand, requireFaultTier, rootCommand }
  from './search-ops-support.ts';

interface RebuildJson {
  generation: string;
  removed: number;
  replayed: number;
  offlineLog?: string;
  logPath: string;
}

test('an interrupted public search rebuild resumes through activation', async () => {
  const { runId } = requireFaultTier();
  const stack = qaStack(`${runId}-rb`);
  let started = false;
  let contentPool: Pool | undefined;
  let accessPool: Pool | undefined;
  const previousFlag = process.env[SEARCH_REBUILD_CRASH_FLAG];
  const previousAt = process.env[SEARCH_REBUILD_CRASH_AT];
  try {
    started = true;
    delete process.env[SEARCH_REBUILD_CRASH_FLAG];
    delete process.env[SEARCH_REBUILD_CRASH_AT];
    await rootCommand(['stack:up', ...stack.args], 180_000);
    const apps = stack.apps;
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    const env = { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
    await initializeFreshGraph(fuseki, lineage);
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 4 });
    await migrateContent(contentPool);
    const content = new ContentCore(contentPool);
    const cursor = new ContentProjectionCursor(contentPool);
    const consumer = apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1';
    await seedRecoveryContent(env, contentPool, accessPool);
    const cut = await content.ownerPosition();
    await cursor.initialize(consumer);
    for (let i = 0; i < 10 && (await cursor.read(consumer)).sequence !== cut.sequence; i++) {
      const next = await relayContentProjectionOnce(env, content, cursor, consumer);
      if (!next) throw new Error('Content outbox stopped before source cut');
    }
    expect((await cursor.read(consumer)).sequence).toBe(cut.sequence);
    const population = await contentUnitCount(fuseki);
    expect(population).toBeGreaterThan(0);

    const opened = await rebuild();
    expect(opened).toContain('content-rebuild step: activated');
    let generation = lastJson<RebuildJson>(opened).generation;
    await expectReady(generation, population);

    for (const point of SEARCH_REBUILD_CRASH_POINTS) {
      const failed = await crash(point);
      expect(failed).toContain(`search rebuild crash: ${point}`);
      if (point === 'after-quarantine') {
        expect(await anchorPresent(fuseki)).toBe(false);
        expect(await contentUnitCount(fuseki)).toBe(population);
        expect(await controlGeneration(fuseki)).toBe(generation);
      }
      const resumed = await rebuild();
      expect(resumed).toContain('content-rebuild step: activated');
      const result = lastJson<RebuildJson>(resumed);
      expect(result.generation).not.toBe(generation);
      generation = result.generation;
      await expectReady(generation, population);
    }
  } finally {
    if (previousFlag === undefined) delete process.env[SEARCH_REBUILD_CRASH_FLAG];
    else process.env[SEARCH_REBUILD_CRASH_FLAG] = previousFlag;
    if (previousAt === undefined) delete process.env[SEARCH_REBUILD_CRASH_AT];
    else process.env[SEARCH_REBUILD_CRASH_AT] = previousAt;
    await Promise.all([contentPool?.end(), accessPool?.end()]);
    if (started) await rootCommand(['stack:reset', ...stack.args], 120_000);
  }

  async function rebuild(): Promise<string> {
    return rootCommand(['search:rebuild', ...stack.args, '--reserve-bytes', '0'], 420_000);
  }

  async function crash(point: SearchRebuildCrashPoint): Promise<string> {
    process.env[SEARCH_REBUILD_CRASH_FLAG] = '1';
    process.env[SEARCH_REBUILD_CRASH_AT] = point;
    try {
      return await refusedRootCommand(['search:rebuild', ...stack.args, '--reserve-bytes', '0'], 420_000);
    } finally {
      delete process.env[SEARCH_REBUILD_CRASH_FLAG];
      delete process.env[SEARCH_REBUILD_CRASH_AT];
    }
  }

  async function expectReady(expectedGeneration: string, units: number): Promise<void> {
    expect(await anchorPresent(fuseki)).toBe(true);
    expect((await fuseki.searchDeltaSince('-1')).available).toBe(true);
    expect(await contentUnitCount(fuseki)).toBe(units);
    expect(await controlGeneration(fuseki)).toBe(expectedGeneration);
    const position = await assertPublicTextReady(fuseki, lineage);
    const typeahead = await querySearchFields(env, { phrase: 'recovery', language: null }, position, {}, true);
    expect(typeahead.some(hit => hit.matchedText.toLowerCase().includes('recovery'))).toBe(true);
    const phrase = await queryPublicContentPhrase(env, content, cursor, consumer, {
      phrase: 'exact content beacon', language: 'en' });
    expect(phrase).toMatchObject({ complete: true, total: 1 });
  }
}, qaStartupTestTimeout(1_800_000));

async function anchorPresent(fuseki: FusekiClient): Promise<boolean> {
  const answer = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
    ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor . } }`);
  return answer.boolean === true;
}

async function contentUnitCount(fuseki: FusekiClient): Promise<number> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(DISTINCT ?unit) AS ?count) WHERE {
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit a rv:MatchUnit ; rv:projection ?projection .
      FILTER(STRSTARTS(STR(?unit), "urn:rezics:content:match-unit:")
        && STRSTARTS(STR(?projection), "urn:rezics:content:projection:")) } }`);
  const count = Number(result.results?.bindings?.[0]?.count?.value);
  if (!Number.isSafeInteger(count)) throw new Error('Content unit count is unreadable');
  return count;
}

async function controlGeneration(fuseki: FusekiClient): Promise<string> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?generation WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:textIndexGeneration ?generation } }`);
  const generation = result.results?.bindings?.[0]?.generation?.value ?? '';
  if (!generation.startsWith('urn:rezics:text-index-generation:')) throw new Error('text generation is unreadable');
  return generation;
}
