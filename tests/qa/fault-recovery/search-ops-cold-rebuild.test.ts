import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { MAX_SEARCH_FUSEKI_CALLS, MAX_SEARCH_REQUEST_MS }
  from '../../../services/main/src/modules/work/search-readiness.ts';
import { assertStorageHeadroom, storageHeadroom } from '../../../scripts/operations/search-state.ts';
import { seedLoadCorpus } from '../load/corpus.ts';
import { migrateAccess, qaStack, refusedRootCommand, requireFaultTier, rootCommand }
  from './search-ops-support.ts';

class CountingFusekiClient extends FusekiClient {
  queries = 0;
  health = 0;
  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    this.queries++;
    return super.query(sparql, maxResponseBytes);
  }
  override async commandHealth() {
    this.health++;
    return super.commandHealth();
  }
}

test('OPS09: a cold public Content body read and exact RDF/Lucene rebuild stay within API and storage budgets', async () => {
  const { runId, artifacts } = requireFaultTier();
  const stack = qaStack(`${runId}-cb`);
  let started = false;
  let contentPool: Pool | undefined;
  let accessPool: Pool | undefined;
  try {
    started = true;
    rootCommand(['stack:up', ...stack.args], 180_000);
    const apps = stack.apps;
    const fuseki = new CountingFusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
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
    const corpus = await seedLoadCorpus(env, contentPool, accessPool);
    const cut = await content.ownerPosition();
    await cursor.initialize(consumer);
    for (let i = 0; i < 10 && (await cursor.read(consumer)).sequence !== cut.sequence; i++) {
      const next = await relayContentProjectionOnce(env, content, cursor, consumer);
      if (!next) throw new Error('Content outbox stopped before source cut');
    }
    expect((await cursor.read(consumer)).sequence).toBe(cut.sequence);
    const input = { phrase: 'exact content beacon', language: 'en' };
    const before = await queryPublicContentPhrase(env, content, cursor, consumer, input);
    expect(before).toMatchObject({ complete: true, total: 1,
      results: [{ resource: corpus.works[0] }] });
    const exactRevision = before.results[0]!.revision.slice('urn:rezics:content:revision:'.length);
    const exact = (await content.readExactBatch([exactRevision], async ids => new Set(ids)))[0];
    expect(exact?.status).toBe('available');
    if (exact?.status !== 'available') throw new Error('exact Content body is unavailable');
    expect(exact.body.body).toBe(input.phrase);

    // Restart evicts the JVM's qualified membership cache. The public route's
    // shared wall/call/byte budget applies to this first read after restart.
    stack.runner.stop();
    await stack.runner.start();
    const app = createMainApp(fuseki, { environment: env,
      account: { verify: async () => corpus.content.principal },
      access: new AccessAdmissionRegistry(accessPool), content,
      contentProjection: { content, cursor, consumer } });
    const beforeCalls = fuseki.queries + fuseki.health;
    const readStarted = performance.now();
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-content-phrase-v1', ...input }),
    }));
    const apiMs = Math.round(performance.now() - readStarted);
    const calls = fuseki.queries + fuseki.health - beforeCalls;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: true, total: 1,
      results: [{ revision: before.results[0]!.revision }] });
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(MAX_SEARCH_FUSEKI_CALLS);
    expect(apiMs).toBeLessThanOrEqual(MAX_SEARCH_REQUEST_MS + 100);

    const storage = storageHeadroom(stack.runner, 0);
    assertStorageHeadroom(storage);
    expect(storage.freeBytes).toBeGreaterThanOrEqual(storage.requiredBytes);
    // An impossible reserve refuses before the quarantine command; the saved
    // job then resumes normally with a valid reserve.
    const impossible = storage.freeBytes + 1;
    expect(Number.isSafeInteger(impossible)).toBe(true);
    const denied = refusedRootCommand(['search:rebuild', ...stack.args,
      '--reserve-bytes', String(impossible)], 120_000);
    expect(denied).toContain('insufficient storage headroom');
    const still = await queryPublicContentPhrase(env, content, cursor, consumer, input);
    expect(still).toMatchObject({ complete: true, total: 1,
      indexGeneration: before.indexGeneration });

    const operation = rootCommand(['search:rebuild', ...stack.args, '--reserve-bytes', '0'], 420_000);
    const result = JSON.parse(operation.trim().split(/\r?\n/).at(-1) ?? '') as {
      generation: string; removed: number; replayed: number;
      logPath: string; storage: { freeBytes: number; requiredBytes: number };
      elapsedMs: { verify: number; replay: number; offline: number; activate: number } };
    expect(result.generation).not.toBe(before.indexGeneration);
    expect(result.removed).toBe(1);
    expect(result.replayed).toBeGreaterThan(0);
    expect(result.storage.freeBytes).toBeGreaterThanOrEqual(result.storage.requiredBytes);
    expect(result.elapsedMs.offline).toBeLessThan(300_000);
    expect(readFileSync(result.logPath, 'utf8')).toMatch(/properties indexed/);
    const after = await queryPublicContentPhrase(env, content, cursor, consumer, input);
    expect(after).toMatchObject({ complete: true, total: 1,
      contentPosition: cut, indexGeneration: result.generation,
      results: [{ revision: before.results[0]!.revision, resource: corpus.works[0] }] });
    expect(after.results[0]!.matchUnit).not.toBe(before.results[0]!.matchUnit);
    writeFileSync(join(artifacts, 'search-ops-cold-rebuild.json'), JSON.stringify({
      runId, coldApiMs: apiMs, coldApiFusekiCalls: calls, sourceCut: cut,
      oldGeneration: before.indexGeneration, newGeneration: result.generation,
      storage: result.storage, elapsedMs: result.elapsedMs, removed: result.removed,
      replayed: result.replayed,
    }, null, 2) + '\n');
  } finally {
    await Promise.all([contentPool?.end(), accessPool?.end()]);
    if (started) rootCommand(['stack:reset', ...stack.args], 120_000);
  }
}, 600_000);
