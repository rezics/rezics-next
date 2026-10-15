import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { deliverFixtureContentEligibility } from '../fixtures/content-projection.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { DATASET, GRAPHS, PUBLIC_SEARCH_ANCHOR, RV, initializeFreshGraph, iri, lit }
  from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady } from '../../../services/main/src/modules/work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';
import { seedRecoveryContent } from './search-content-fixture.ts';
import { lastJson, migrateAccess, qaStack, refusedRootCommand, requireFaultTier, rootCommand }
  from './search-ops-support.ts';

interface RebuildJson {
  job: string;
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
  let fuseki: FusekiClient | undefined;
  let lineage: { dataEpoch: string; routingEpoch: string } | undefined;
  let env: { fuseki: FusekiClient; lineage: { dataEpoch: string; routingEpoch: string }; objectDirectory: string } | undefined;
  let content: ContentCore | undefined;
  let cursor: ContentProjectionCursor | undefined;
  let consumer = '';
  const previousFlag = process.env[SEARCH_REBUILD_CRASH_FLAG];
  const previousAt = process.env[SEARCH_REBUILD_CRASH_AT];
  try {
    started = true;
    delete process.env[SEARCH_REBUILD_CRASH_FLAG];
    delete process.env[SEARCH_REBUILD_CRASH_AT];
    await rootCommand(['stack:up', ...stack.args], 180_000);
    const apps = stack.apps;
    fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    env = { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
    await initializeFreshGraph(fuseki, lineage);
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 4 });
    await migrateContent(contentPool);
    content = new ContentCore(contentPool);
    cursor = new ContentProjectionCursor(contentPool);
    consumer = apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1';
    await seedRecoveryContent(env, contentPool, accessPool);
    await deliverFixtureContentEligibility(env, content, apps.MAIN_RELAY_DATABASE_URL);
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
      if (point === 'after-replay') {
        // Deleting a committed offline receipt corrupts the frozen authority
        // chain. Refuse it, then restore the exact retained proof and resume.
        if (!content || !contentPool) throw new Error('search rebuild fixture is absent');
        const saved = JSON.parse(readFileSync(join(stack.directory, 'content-rebuild.json'), 'utf8')) as { id: string };
        const cursorAt = await contentPool.query(
          `SELECT sequence::text AS sequence FROM content.projection_checkpoint WHERE consumer = $1`,
          [`content-rebuild.${saved.id}`]);
        expect(cursorAt.rows[0]?.sequence).toBe((await content.ownerPosition()).sequence);
        expect(cursorAt.rows[0]?.sequence).not.toBe('0');
        const evidence = `PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
          ?receipt rv:rebuildJob ${JSON.stringify(saved.id)} ; rv:indexRebuildDigest ?digest . } }`;
        expect((await fuseki.query(evidence)).boolean).toBe(true);
        const retained = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?p ?o WHERE {
          GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:rebuildJob ${lit(saved.id)} ;
            rv:indexRebuildDigest ?digest ; ?p ?o } }`)).results!.bindings;
        const retainedIri = (value: string) => {
          if (!/^(?:https?:|urn:)[^<>"\s]+$/u.test(value)) throw new Error('Invalid retained proof IRI');
          return `<${value}>`;
        };
        const restore = `INSERT DATA { GRAPH ${iri(GRAPHS.receipts)} {
          ${retained.map(row => {
            const value = row.o!;
            const object = value.type === 'uri' ? retainedIri(value.value) : lit(value.value)
              + (value['xml:lang'] ? `@${value['xml:lang']}` : value.datatype ? `^^${retainedIri(value.datatype)}` : '');
            return `${retainedIri(row.receipt!.value)} ${retainedIri(row.p!.value)} ${object} .`;
          }).join('\n')} } }`;
        // The persistent product assembler has no SPARQL update service. The
        // fault write goes through tdb2 while Fuseki is stopped, then the same
        // server comes back.
        const jobLiteral = JSON.stringify(saved.id);
        stack.runner.stop();
        try {
          stack.runner.offline(`cat > /tmp/drop-offline-evidence.ru << 'EOF'
PREFIX rv: <${RV}>
DELETE { GRAPH <urn:rezics:graph:receipts> { ?receipt ?p ?o } }
WHERE { GRAPH <urn:rezics:graph:receipts> {
  ?receipt rv:rebuildJob ${jobLiteral} ; rv:indexRebuildDigest ?digest ; ?p ?o } }
EOF
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/drop-offline-evidence.ru
rm -f /tmp/drop-offline-evidence.ru`);
        } finally {
          await stack.runner.start();
        }
        expect((await fuseki.query(evidence)).boolean).toBe(false);
        const refused = await refusedRootCommand(['search:rebuild', ...stack.args, '--reserve-bytes', '0'], 420_000);
        expect(refused).toContain('graph authority moved after frozen rebuild cut');
        stack.runner.stop();
        try {
          stack.runner.offline(`cat > /tmp/restore-offline-evidence.ru << 'EOF'
${restore}
EOF
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/restore-offline-evidence.ru
rm -f /tmp/restore-offline-evidence.ru`);
        } finally {
          await stack.runner.start();
        }
        expect((await fuseki.query(evidence)).boolean).toBe(true);
        const resumed = await rebuild();
        expect(resumed).toContain('content-rebuild step: activated');
        const fresh = lastJson<RebuildJson>(resumed);
        expect(fresh.job).toBe(saved.id);
        expect(fresh.generation).not.toBe(generation);
        generation = fresh.generation;
        await expectReady(generation, population);
        continue;
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
    if (!fuseki || !lineage || !env || !content || !cursor) throw new Error('search rebuild fixture is absent');
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
