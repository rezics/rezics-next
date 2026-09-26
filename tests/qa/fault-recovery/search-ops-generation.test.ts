import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { searchGenerationRoutes } from '../../../services/main/src/routes/search-generations.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { activateMetadataWork, DATASET, GRAPHS, initializeFreshGraph, iri,
  metadataWorkRequestDigest, RV } from '../../../services/main/src/modules/work/activate.ts';
import { SearchIndexUncertain, assertPublicTextReady }
  from '../../../services/main/src/modules/work/search-readiness.ts';
import { assertPinnedState, inspectFusekiState, repositoryPins, restoreStateVolume }
  from '../../../scripts/operations/search-state.ts';
import { pinnedImage, qaStack, requireFaultTier, root, rootCommand, standaloneFuseki }
  from './search-ops-support.ts';

type Generation = { state: string; dataEpoch: string; sequence: string; generation: string;
  activation: null | { receipt: string; graphSequence: string; sourceCut: { sequence: string };
    indexDigest: string }; population: number | null };

function generationRoute(fuseki: FusekiClient, lineage: { dataEpoch: string; routingEpoch: string }) {
  const dependencies = { environment: { fuseki, lineage },
    account: {}, access: {} } as MainWorkDependencies;
  const app = searchGenerationRoutes(fuseki, dependencies);
  return async (): Promise<{ response: Response; body: Generation }> => {
    const response = await app.handle(new Request('http://main.local/v1/search/generations/current'));
    return { response, body: await response.json() as Generation };
  };
}

test('OPS15/OPS16: a crash retains the TDB2 receipt, fences text, and a pinned rebuild activates a qualified generation', async () => {
  const { runId, artifacts } = requireFaultTier();
  const stack = qaStack(`${runId}-gn`);
  const restoredVolume = `rezics-qa-${runId}-restored`;
  let started = false;
  let restored: Awaited<ReturnType<typeof standaloneFuseki>> | undefined;
  let pool: Pool | undefined;
  try {
    started = true;
    rootCommand(['stack:up', ...stack.args], 180_000);
    const fuseki = stack.fuseki;
    const lineage = { dataEpoch: stack.apps.MAIN_DATA_EPOCH!, routingEpoch: stack.apps.MAIN_ROUTING_EPOCH! };
    const env = { fuseki, lineage, objectDirectory: stack.apps.MAIN_OBJECT_DIRECTORY! };
    await initializeFreshGraph(fuseki, lineage);
    const current = generationRoute(fuseki, lineage);
    const initial = await current();
    expect(initial.response.status).toBe(200);
    expect(initial.body).toMatchObject({ state: 'active', dataEpoch: lineage.dataEpoch,
      activation: null, population: 0 });

    const id = randomUUID();
    const title = `Crash receipt ${id}`;
    const created = await activateMetadataWork(env, { title,
      admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `crash-${id}`, requestDigest: metadataWorkRequestDigest(title),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const receipt = created.receipt;
    const committed = await current();
    expect(committed.body.state).toBe('active');
    expect(BigInt(committed.body.sequence)).toBeGreaterThan(BigInt(initial.body.sequence));

    // A hard kill after commit leaves the graph receipt durable but marks text uncertain.
    const killed = stack.compose(['kill', '-s', 'SIGKILL', 'fuseki']);
    expect(killed.status).toBe(0);
    await stack.runner.start();
    const receiptAnswer = await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:outcome rv:Succeeded . }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${committed.body.sequence} . }
    }`);
    expect(receiptAnswer.boolean).toBe(true);
    expect((await fuseki.commandHealth() as { textIndexUncertain: boolean }).textIndexUncertain).toBe(true);
    await expect(assertPublicTextReady(fuseki, lineage)).rejects.toBeInstanceOf(SearchIndexUncertain);
    const uncertain = await current();
    expect(uncertain.response.status).toBe(200);
    expect(uncertain.body).toMatchObject({ state: 'uncertain', population: null,
      sequence: committed.body.sequence, generation: committed.body.generation });

    // The operator command performs exact source replay, empty-index replacement,
    // pin checks and generation activation while Main writers are absent.
    pool = new Pool({ connectionString: stack.apps.CONTENT_DATABASE_URL!, max: 4 });
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const cut = await content.ownerPosition();
    const cursor = new ContentProjectionCursor(pool);
    await cursor.initialize(stack.apps.CONTENT_PROJECTION_CONSUMER ?? 'main-content-public-search-v1');
    const operation = rootCommand(['search:rebuild', ...stack.args, '--reserve-bytes', '0'], 420_000);
    const result = JSON.parse(operation.trim().split(/\r?\n/).at(-1) ?? '') as {
      generation: string; pins: { stateVolume: string }; storage: { freeBytes: number; requiredBytes: number } };
    expect(result.storage.freeBytes).toBeGreaterThanOrEqual(result.storage.requiredBytes);
    expect(result.pins.stateVolume).toBe(stack.stateVolume);
    expect(result.generation).not.toBe(committed.body.generation);
    const active = await current();
    expect(active.response.status).toBe(200);
    expect(active.body).toMatchObject({ state: 'active', generation: result.generation, population: 0,
      activation: { sourceCut: { sequence: cut.sequence } } });
    expect(active.body.activation?.graphSequence).toBe(active.body.sequence);
    expect(active.body.activation?.indexDigest).toMatch(/^[0-9a-f]{64}$/);

    // Restore only a stopped named volume. The original and replacement volumes
    // remain distinct, and a restored text reader begins in the uncertain state.
    expect(() => restoreStateVolume(stack.dockerEnv, pinnedImage(), stack.stateVolume,
      restoredVolume)).toThrow(/owned by a running process/);
    stack.runner.stop();
    restoreStateVolume(stack.dockerEnv, pinnedImage(), stack.stateVolume, restoredVolume);
    await stack.runner.start();
    restored = await standaloneFuseki(stack.dockerEnv, { name: restoredVolume,
      image: pinnedImage(), volume: restoredVolume, secrets: {
        FUSEKI_MAINTENANCE_TOKEN: stack.composeEnv.FUSEKI_MAINTENANCE_TOKEN!,
        FUSEKI_COMMAND_TOKEN: stack.composeEnv.FUSEKI_COMMAND_TOKEN!,
        FUSEKI_TITLE_ADMISSION_KEY: stack.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
      } });
    const restoredClient = new FusekiClient(restored.url,
      stack.composeEnv.FUSEKI_MAINTENANCE_TOKEN!, stack.composeEnv.FUSEKI_COMMAND_TOKEN!);
    const expected = repositoryPins(root, stack.dockerEnv, restoredVolume, [stack.stateVolume]);
    const pins = await inspectFusekiState(restored.runner, stack.dockerEnv, restoredClient);
    expect(() => assertPinnedState(pins, expected)).not.toThrow();
    expect(() => assertPinnedState({ ...pins, facts: { ...pins.facts,
      analyzer: 'org.apache.lucene.analysis.standard.StandardAnalyzer' } }, expected))
      .toThrow(/analyzer/);
    expect(() => assertPinnedState({ ...pins, stateVolume: stack.stateVolume },
      { ...expected, stateVolume: stack.stateVolume })).toThrow(/isolated original/);
    const restoredGeneration = await generationRoute(restoredClient, lineage)();
    expect(restoredGeneration.body).toMatchObject({ state: 'uncertain',
      sequence: active.body.sequence, generation: active.body.generation, population: null });
    expect((await current()).body.state).toBe('active');
    writeFileSync(join(artifacts, 'search-ops-generation.json'), JSON.stringify({
      runId, receipt, crashSequence: committed.body.sequence, sourceCut: cut,
      rebuiltGeneration: active.body, restoredGeneration: restoredGeneration.body,
      sourceVolume: stack.stateVolume, restoredVolume, pins,
    }, null, 2) + '\n');
  } finally {
    restored?.remove();
    stack.compose(['stop', 'fuseki']);
    stack.compose(['rm', '-sf', 'fuseki']);
    const { spawnSync } = await import('node:child_process');
    spawnSync('docker', ['volume', 'rm', '-f', restoredVolume], { env: stack.dockerEnv, timeout: 60_000 });
    if (pool) await pool.end();
    if (started) rootCommand(['stack:reset', ...stack.args], 120_000);
  }
}, 600_000);
