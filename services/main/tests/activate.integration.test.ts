import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { createMainApp } from '../src/app.ts';
import {
  activateMetadataWork, IdempotencyConflict, initializeFreshGraph, PendingActivation,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');
const fusekiHome = Bun.env.REZICS_FUSEKI_HOME;
const javaHome = Bun.env.REZICS_JAVA_HOME;
const jenaHome = Bun.env.REZICS_JENA_HOME;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function ready(fuseki: FusekiClient): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fuseki.query('ASK {}')).boolean === true) return;
    } catch { /* process may still be starting */ }
    await Bun.sleep(250);
  }
  throw new Error('Fuseki did not start within 30 seconds');
}

test('SYS02/SYS10/SYS14: guarded Work storage and real Main readiness', async () => {
  if (!fusekiHome || !javaHome || !jenaHome) throw new Error('Set REZICS_FUSEKI_HOME, REZICS_JAVA_HOME and REZICS_JENA_HOME');
  const state = join(root, '.temp', `main-integration-${Bun.randomUUIDv7()}`);
  const base = join(state, 'run');
  mkdirSync(join(base, 'databases/rezics/tdb2'), { recursive: true });
  mkdirSync(join(base, 'databases/rezics/lucene'), { recursive: true });
  copyFileSync(join(root, 'docs/operations/examples/fuseki-text.ttl'), join(base, 'fuseki-text.ttl'));
  const port = await freePort();
  const log = openSync(join(state, 'fuseki.log'), 'w');
  const serverProcess = spawn(join(fusekiHome, 'fuseki-server'), [
    '--localhost', `--port=${port}`, '--no-cors', '--timeout=10000', `--config=${join(base, 'fuseki-text.ttl')}`,
  ], {
    cwd: base,
    env: { ...process.env, JAVA_HOME: javaHome, FUSEKI_HOME: fusekiHome, FUSEKI_BASE: base, MAIN: 'main', JVM_ARGS: '-Xms128m -Xmx1g' },
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  const fuseki = new FusekiClient(`http://127.0.0.1:${port}/rezics`);
  const lineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '1' };
  const env: WorkActivationEnvironment = {
    fuseki, lineage,
    objectDirectory: join(state, 'objects'), candidateDirectory: join(state, 'candidates'),
    repositoryRoot: root, jenaHome, javaHome, python: 'python3',
  };
  try {
    await ready(fuseki);
    const app = createMainApp(fuseki);
    const mainPort = await freePort();
    app.listen({ hostname: '127.0.0.1', port: mainPort });
    try {
      const readyResponse = await fetch(`http://127.0.0.1:${mainPort}/health/ready`);
      expect(readyResponse.status).toBe(200);
      expect(await readyResponse.json()).toEqual({ status: 'ready' });
    } finally {
      await app.stop();
    }
    const unavailablePort = await freePort();
    const unavailable = await createMainApp(new FusekiClient(`http://127.0.0.1:${unavailablePort}/rezics`))
      .handle(new Request('http://localhost/health/ready'));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: 'unavailable' });
    await initializeFreshGraph(fuseki, lineage);

    const intent = { admittedScope: 'test-principal-1', idempotencyKey: 'create-1', title: 'First metadata Work' };
    const created = await activateMetadataWork(env, intent);
    expect(created.replayed).toBe(false);
    expect(created.sequence).toBe('1');
    expect(created.dataEpoch).toBe(lineage.dataEpoch);
    expect(created.work).toMatch(/^https:\/\/rezics\.com\/id\/[0-9a-f-]+$/);
    const replay = await activateMetadataWork(env, intent);
    expect(replay).toEqual({ ...created, replayed: true });
    await expect(activateMetadataWork(env, { ...intent, title: 'Other title' })).rejects.toBeInstanceOf(IdempotencyConflict);

    const graph = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?main ?workRevision ?mainRevision WHERE {
      GRAPH <urn:rezics:graph:current> {
        <${created.work}> rv:mainVersion ?main ; rv:head ?workRevision .
        ?main rv:work <${created.work}> ; rv:head ?mainRevision .
      }
    }`);
    const current = graph.results?.bindings;
    expect(current?.length).toBe(1);
    expect(current?.[0]?.main?.value).toBe(created.mainVersion);
    const textMatch = await fuseki.query(`PREFIX text: <http://jena.apache.org/text#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT ?work WHERE { GRAPH <urn:rezics:graph:current> {
        (?work ?score ?literal) text:query (rdfs:label "First" 10) .
        ?work rdfs:label ?literal .
      } }`);
    expect(textMatch.results?.bindings.map((row) => row.work?.value)).toContain(created.work);
    const revision = current?.[0]?.workRevision?.value;
    expect(revision).toBeDefined();
    const manifestResult = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?manifest WHERE {
      GRAPH <urn:rezics:graph:revisions> { <${revision}> rv:manifest ?manifest }
    }`);
    const manifestIri = manifestResult.results?.bindings[0]?.manifest?.value;
    expect(manifestIri).toMatch(/^urn:rezics:sha256:[0-9a-f]{64}$/);
    const manifestHash = manifestIri!.split(':').at(-1)!;
    const manifest = JSON.parse(readFileSync(join(env.objectDirectory, manifestHash), 'utf8'));
    expect(manifest.component).toBe(created.work);
    expect(manifest.payload).toMatch(/^sha256:[0-9a-f]{64}$/);
    const payloadHash = manifest.payload.split(':').at(-1);
    const payload = readFileSync(join(env.objectDirectory, payloadHash));
    expect(createHash('sha256').update(payload).digest('hex')).toBe(payloadHash);

    class LostResponseClient extends FusekiClient {
      override async update(sparql: string): Promise<void> {
        await super.update(sparql);
        throw new Error('simulated lost response');
      }
    }
    const lost = await activateMetadataWork({ ...env, fuseki: new LostResponseClient(`http://127.0.0.1:${port}/rezics`) },
      { admittedScope: 'test-principal-1', idempotencyKey: 'lost-response', title: 'Recovered Work' });
    expect(lost.sequence).toBe('2');

    const sameKey = { admittedScope: 'test-principal-1', idempotencyKey: 'race', title: 'Racing Work' };
    const raced = await Promise.all([activateMetadataWork(env, sameKey), activateMetadataWork(env, sameKey)]);
    expect(raced[0]?.work).toBe(raced[1]?.work);
    expect(raced[0]?.sequence).toBe('3');
    expect(raced[1]?.sequence).toBe('3');

    await expect(activateMetadataWork({ ...env, lineage: { ...lineage, dataEpoch: Bun.randomUUIDv7() } },
      { admittedScope: 'test-principal-1', idempotencyKey: 'stale-epoch', title: 'Must not exist' })).rejects.toBeInstanceOf(PendingActivation);
    await expect(activateMetadataWork(env,
      { admittedScope: 'test-principal-1', idempotencyKey: 'invalid-title', title: '' })).rejects.toThrow('invalid title');
    const position = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?sequence WHERE {
      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?sequence }
    }`);
    expect(position.results?.bindings[0]?.sequence?.value).toBe('3');
    const outbox = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT (COUNT(?batch) AS ?count) WHERE {
      GRAPH <urn:rezics:graph:outbox> { ?batch a rv:OutboxBatch }
    }`);
    expect(outbox.results?.bindings[0]?.count?.value).toBe('3');
  } finally {
    serverProcess.kill('SIGTERM');
    if (serverProcess.exitCode === null) {
      await new Promise<void>((resolveExit) => serverProcess.once('exit', () => resolveExit()));
    }
  }
}, 120_000);
