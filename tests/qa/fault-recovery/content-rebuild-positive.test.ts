import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { activateRebuiltPublicContentSearch, quarantinePublicContentSearch }
  from '../../../services/main/src/modules/content-publication/rebuild.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../../../services/main/src/modules/content-publication/search.ts';
import { initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady } from '../../../services/main/src/modules/work/search-readiness.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { seedLoadCorpus } from '../load/corpus.ts';

const root = resolve(import.meta.dir, '../../..');

function rootCommand(args: string[], timeout: number): string {
  const result = spawnSync('corepack', ['yarn', ...args], { cwd: root,
    encoding: 'utf8', timeout, maxBuffer: 4_000_000 });
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(-4000)}`);
  }
  return result.stdout;
}

async function migrateAccess(url: string): Promise<void> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const directory = join(root, 'services/main/migrations/access');
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort()) {
      await db.query(readFileSync(join(directory, file), 'utf8'));
    }
  } finally { await db.end(); }
}

test('SEARCH20/OPS16: isolated persistent offline rebuild resumes and reactivates exact Content', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through the isolated fault/recovery QA tier');
  }
  const runId = `${Bun.env.REZICS_QA_RUN_ID}-pr`;
  const options = { profile: 'qa' as const, runId, persistent: true };
  const stackArgs = ['--profile', 'qa', '--run-id', runId, '--persistent'];
  const startedAt = Date.now();
  let started = false;
  try {
    started = true;
    rootCommand(['stack:up', ...stackArgs], 180_000);
    const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
    const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!,
      apps.FUSEKI_COMMAND_TOKEN!);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(fuseki, lineage);
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 4 });
    const accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 4 });
    try {
      await migrateContent(contentPool);
      const content = new ContentCore(contentPool);
      const cursor = new ContentProjectionCursor(contentPool);
      const consumer = apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1';
      const env = { fuseki, lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
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
      expect(before.complete).toBe(true);
      expect(before.total).toBe(1);
      expect(before.results[0]?.resource).toBe(corpus.works[0]);
      const exactRevision = before.results[0]!.revision.slice('urn:rezics:content:revision:'.length);
      const exact = (await content.readExactBatch([exactRevision], async ids => new Set(ids)))[0];
      expect(exact?.status).toBe('available');
      if (exact?.status !== 'available') throw new Error('fixture exact Content bytes are unavailable');
      expect(exact.body.body).toBe('exact content beacon');

      const jobId = randomUUID();
      const job = await quarantinePublicContentSearch(env, content, jobId);
      expect(job.cut).toEqual(cut);
      await expect(assertPublicTextReady(fuseki, lineage)).rejects.toThrow();
      // A digest alone cannot substitute for the native clear/replay receipt chain.
      await expect(activateRebuiltPublicContentSearch(env, content, cursor, job,
        consumer, 'a'.repeat(64))).rejects.toThrow('Content cleanup receipt is absent');
      const quarantined = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab#> ASK {
        GRAPH <urn:rezics:graph:public-search> {
          <urn:rezics:search:public:anchor> a rv:SearchGraphAnchor . } }`);
      expect(quarantined.boolean).toBe(false);

      // Simulate interruption after the durable quarantine receipt. The root
      // operator command resumes this job and performs the actual offline pass.
      const operation = rootCommand(['search:rebuild', '--job', jobId, ...stackArgs], 420_000);
      const line = operation.trim().split(/\r?\n/).at(-1);
      const result = JSON.parse(line ?? '') as { job: string; removed: number;
        replayed: number; generation: string; logPath: string };
      expect(result.job).toBe(jobId);
      expect(result.removed).toBe(1);
      expect(result.replayed).toBeGreaterThan(0);
      expect(result.generation).not.toBe(before.indexGeneration);
      expect(readFileSync(result.logPath, 'utf8')).toMatch(/textindexer\s+::\s+\d+ \(\d+ per second\) properties indexed/);
      const after = await queryPublicContentPhrase(env, content, cursor, consumer, input);
      expect(after.complete).toBe(true);
      expect(after.population).toBe(1);
      expect(after.total).toBe(1);
      expect(after.results[0]).toMatchObject({ resource: before.results[0]!.resource,
        variant: before.results[0]!.variant, revision: before.results[0]!.revision });
      expect(after.results[0]!.matchUnit).not.toBe(before.results[0]!.matchUnit);
      expect(after.contentPosition).toEqual(cut);
      expect(after.indexGeneration).toBe(result.generation);
      expect(BigInt(after.graphPosition.sequence)).toBeGreaterThan(BigInt(before.graphPosition.sequence));
      writeFileSync(join(Bun.env.REZICS_QA_ARTIFACT_DIR, 'content-rebuild-positive.json'),
        JSON.stringify({ runId, job: jobId, oldGeneration: before.indexGeneration,
          newGeneration: after.indexGeneration, oldGraphSequence: before.graphPosition.sequence,
          newGraphSequence: after.graphPosition.sequence, contentCut: cut,
          removed: result.removed, replayed: result.replayed, elapsedMs: Date.now() - startedAt,
          result: after.results[0] }, null, 2) + '\n');
    } finally {
      await Promise.all([contentPool.end(), accessPool.end()]);
    }
  } finally {
    if (started) rootCommand(['stack:reset', ...stackArgs], 120_000);
  }
}, 600_000);
