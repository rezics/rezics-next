import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docker, OFFLINE_INDEX_SCRIPT, OWNER_ENTRYPOINT } from '../../../scripts/operations/search-state.ts';
import { activateMetadataWork, DATASET, GRAPHS, iri, initializeFreshGraph,
  metadataWorkRequestDigest, RV } from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady } from '../../../services/main/src/modules/work/search-readiness.ts';
import { qaStack, requireFaultTier, root, rootCommand } from './search-ops-support.ts';

const OWNED_PATHS = ['infra/jena/fuseki-owner.sh', 'scripts/operations/search-state.ts',
  'scripts/operations/rebuild-content-search.ts', 'scripts/operations/verify_graph_substrate.py',
  'scripts/operations/verify_cjk_rebuild.py'];

test('OPS13: a second JVM on the active TDB2 directory is refused and the owner keeps serving', async () => {
  const { runId, artifacts } = requireFaultTier();
  const stack = qaStack(`${runId}-lk`);
  let started = false;
  try {
    started = true;
    await rootCommand(['stack:up', ...stack.args], 180_000);
    const fuseki = stack.fuseki;
    const lineage = { dataEpoch: stack.apps.MAIN_DATA_EPOCH!, routingEpoch: stack.apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(fuseki, lineage);
    const container = stack.runner.container();
    const inspected = JSON.parse(docker(['inspect', container], stack.dockerEnv, 10_000))[0] as { Path: string };
    expect(inspected.Path).toBe(OWNER_ENTRYPOINT);
    const before = await assertPublicTextReady(fuseki, lineage);
    const state = () => stack.runner.exec('cd /fuseki/databases/rezics && ls -A | sort').trim().split('\n');
    const stateBefore = state();
    expect(stateBefore).not.toContain('lucene.uncertain');

    // A second owner through the image entrypoint stops before inspecting the state.
    const owner = stack.compose(['run', '--rm', '--no-deps', '-T', 'fuseki'], 60_000);
    expect(owner.status).toBe(75);
    expect(owner.output).toContain('another process owns /fuseki/databases/rezics');
    // The repository's own offline indexer takes the same lock and refuses.
    const offline = stack.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'fuseki', '-ec',
      OFFLINE_INDEX_SCRIPT], 60_000);
    expect(offline.status).toBe(75);
    expect(offline.output).toContain('offline index: another process owns');
    // A JVM that bypasses the owner lock still meets TDB2/Lucene locks. Nothing
    // here deletes or overrides a lock file.
    const bypass = stack.compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'java', 'fuseki',
      '-Xmx512m', '-cp', '/opt/apache-jena-fuseki-6.2.0/fuseki-server.jar', 'jena.textindexer',
      '--desc=/fuseki/fuseki-text.ttl'], 120_000);
    expect(bypass.status).not.toBe(0);
    expect(bypass.output).toMatch(/lock/i);
    expect(bypass.output).not.toMatch(/properties indexed/);

    // The owner JVM, its files and its public text proof are unchanged.
    expect(stack.runner.container()).toBe(container);
    expect(state()).toEqual(stateBefore);
    const after = await assertPublicTextReady(fuseki, lineage);
    expect(after).toEqual(before);
    const health = await fuseki.commandHealth() as { instanceId: string; textIndexUncertain?: boolean };
    expect(health.instanceId).toBe(before.serverInstanceId);
    expect(health.textIndexUncertain).toBe(false);
    // The owner still admits a native write through the text dataset.
    const id = randomUUID();
    const title = `Lock owner ${id}`;
    const created = await activateMetadataWork({ fuseki, lineage,
      objectDirectory: stack.apps.MAIN_OBJECT_DIRECTORY! }, { title, admission: { id: randomUUID(),
      scope: 'work:create:root', action: 'work.create', idempotencyKey: `lock-${id}`,
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const sequence = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }`);
    expect(sequence.results?.bindings[0]?.n?.value).toBe(String(BigInt(before.sequence) + 1n));
    expect(created.work).toMatch(/^https:\/\/rezics\.com\/id\//);

    // No operation procedure removes or bypasses a database lock.
    for (const path of OWNED_PATHS) {
      expect(readFileSync(join(root, path), 'utf8')).not.toMatch(/rm\s+(-\w+\s+)*\S*(tdb\.lock|write\.lock)|unlock/i);
    }
    writeFileSync(join(artifacts, 'search-ops-lock.json'), JSON.stringify({ runId, container,
      ownerExit: owner.status, offlineExit: offline.status, bypassExit: bypass.status,
      bypassLock: bypass.output.match(/[^\n]*lock[^\n]*/i)?.[0] ?? null,
      instanceId: before.serverInstanceId, generation: before.generation }, null, 2) + '\n');
  } finally {
    if (started) await rootCommand(['stack:reset', ...stack.args], 120_000);
  }
}, qaStartupTestTimeout(420_000));
