import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { MODEL_CUSTODY_BACKFILL_COST, custodyModelGenerationArtifacts,
  readExactModelGeneration } from '../src/modules/semantic/model-custody.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import { hash, prepareWorkComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { RevisionCorrupt, RevisionUnavailable } from '../src/modules/work/history.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function localDirectory(): string {
  const temp = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(temp, { recursive: true });
  const directory = mkdtempSync(join(temp, 'model-custody-cache-'));
  directories.push(directory);
  return directory;
}

function fakeS3() {
  const prefix = 'semantic/work/';
  const data = new Map<string, Uint8Array>();
  let signal = new AbortController().signal;
  const state: { delayMs: number; onGet?: () => void; corruptDigest?: string } = { delayMs: 0 };
  const counts = { gets: 0, ranges: [] as string[] };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'PUT' && url.pathname === '/rezics-semantic') return new Response(null, { status: 200 });
      if (request.method === 'HEAD' && url.pathname === '/rezics-semantic') return new Response(null, { status: 200 });
      if (!url.pathname.startsWith('/rezics-semantic/')) return new Response(null, { status: 404 });
      const key = decodeURIComponent(url.pathname.slice('/rezics-semantic/'.length));
      if (request.method === 'PUT') {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (!data.has(key)) data.set(key, bytes);
        return new Response(null, { status: 200 });
      }
      if (request.method === 'DELETE') {
        data.delete(key);
        return new Response(null, { status: 204 });
      }
      if (request.method === 'GET') {
        counts.gets++;
        counts.ranges.push(request.headers.get('range') ?? '');
        state.onGet?.();
        if (state.delayMs) await Bun.sleep(state.delayMs);
        if (state.corruptDigest && key.endsWith(state.corruptDigest)) {
          return new Response(Buffer.from('tampered'), { status: 200 });
        }
        const bytes = data.get(key);
        return bytes
          ? new Response(Buffer.from(bytes), { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
          : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 405 });
    },
  });
  servers.push(server);
  const store = new S3ImmutableObjects({
    endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic',
    accessKeyId: 'local-test-key',
    secretAccessKey: 'local-test-secret',
    prefix,
    readSignal: () => signal,
  });
  return {
    store,
    state,
    counts,
    setSignal(next: AbortSignal) { signal = next; },
    remove(digest: string) { data.delete(`${prefix}sha256/${digest}`); },
  };
}

class ModelGraph extends FusekiClient {
  manifest = '';
  commandModule = '';
  constructor() { super('http://unused.invalid'); }

  override async query(query: string): Promise<SparqlResult> {
    const term = (value: string) => ({ type: 'uri', value });
    if (query.includes('SELECT ?manifest ?commandModule')) {
      return { results: { bindings: [{ manifest: term(this.manifest),
        commandModule: { type: 'literal', value: this.commandModule } }] } };
    }
    return { results: { bindings: [] } };
  }
}

async function fixture(shapeBytes = Buffer.from(`shape-${Bun.randomUUIDv7()}`)) {
  const remote = fakeS3();
  const directory = localDirectory();
  const graph = new ModelGraph();
  const env: WorkActivationEnvironment = {
    workObjects: remote.store,
    objectDirectory: directory,
    fuseki: graph,
    lineage: { dataEpoch: 'model-cache-test', routingEpoch: 'model-cache-test' },
  };
  const commandModule = COMMAND_MODULE_VERSION;
  const shapeDigest = hash(shapeBytes);
  const manifestBytes = Buffer.from(JSON.stringify({ commandModule, profiles: [
    { id: 'cache-probe-v1', sha256: shapeDigest, file: 'shapes/cache-probe-v1.ttl' },
  ] }));
  const generation = `urn:rezics:model-generation:${hash(manifestBytes)}`;
  await custodyModelGenerationArtifacts(env, generation, manifestBytes, () => shapeBytes);
  const state = { modelManifestSha256: hash(manifestBytes), commandModule, entailment: 'none' };
  const anchorDigest = await prepareWorkComponent(remote.store, generation, state, PROFILES.generation);
  graph.manifest = `urn:rezics:sha256:${anchorDigest}`;
  graph.commandModule = commandModule;
  return { env, graph, remote, directory, generation, anchorDigest, manifestBytes, shapeBytes, shapeDigest };
}

test('exact model reads verify selected-store bytes without a local model copy', async () => {
  const f = await fixture();
  const exact = await readExactModelGeneration(f.env, f.generation);

  expect(exact.manifest).toEqual(new Uint8Array(f.manifestBytes));
  expect(exact.shapes).toEqual([{ profile: 'cache-probe-v1', sha256: f.shapeDigest,
    bytes: new Uint8Array(f.shapeBytes) }]);
  expect(f.remote.counts.gets).toBeGreaterThan(0);
  expect(existsSync(join(f.directory, f.shapeDigest))).toBe(false);
});

test('exact model reads see selected-store loss and corruption after a digest was cached', async () => {
  const missing = await fixture();
  await readExactModelGeneration(missing.env, missing.generation);
  missing.remote.remove(missing.shapeDigest);
  const beforeMissingRead = missing.remote.counts.gets;
  await expect(readExactModelGeneration(missing.env, missing.generation))
    .rejects.toBeInstanceOf(RevisionUnavailable);
  expect(missing.remote.counts.gets).toBeGreaterThan(beforeMissingRead);

  const corrupt = await fixture();
  await readExactModelGeneration(corrupt.env, corrupt.generation);
  corrupt.remote.state.corruptDigest = corrupt.shapeDigest;
  const beforeCorruptRead = corrupt.remote.counts.gets;
  await expect(readExactModelGeneration(corrupt.env, corrupt.generation))
    .rejects.toBeInstanceOf(RevisionCorrupt);
  expect(corrupt.remote.counts.gets).toBeGreaterThan(beforeCorruptRead);
});

test('retained generation state does not trust its cached selected-store copy', async () => {
  const missing = await fixture();
  await readExactModelGeneration(missing.env, missing.generation);
  missing.remote.remove(missing.anchorDigest);
  const beforeRead = missing.remote.counts.gets;
  await expect(readExactModelGeneration(missing.env, missing.generation))
    .rejects.toBeInstanceOf(RevisionUnavailable);
  expect(missing.remote.counts.gets).toBeGreaterThan(beforeRead);

  const corrupt = await fixture();
  await readExactModelGeneration(corrupt.env, corrupt.generation);
  corrupt.remote.state.corruptDigest = corrupt.anchorDigest;
  const beforeCorruptRead = corrupt.remote.counts.gets;
  await expect(readExactModelGeneration(corrupt.env, corrupt.generation))
    .rejects.toBeInstanceOf(RevisionCorrupt);
  expect(corrupt.remote.counts.gets).toBeGreaterThan(beforeCorruptRead);
});

test('retained model store reads preserve the configured abort signal', async () => {
  const f = await fixture();
  await readExactModelGeneration(f.env, f.generation);
  const controller = new AbortController();
  f.remote.setSignal(controller.signal);
  f.remote.state.delayMs = 40;
  f.remote.state.onGet = () => setTimeout(() => controller.abort(), 5);
  const beforeRead = f.remote.counts.gets;

  await expect(readExactModelGeneration(f.env, f.generation)).rejects.toBeInstanceOf(RevisionUnavailable);
  expect(f.remote.counts.gets).toBeGreaterThan(beforeRead);
});

test('retained model artifact reads keep the existing per-artifact byte limit', async () => {
  const tooLarge = Buffer.alloc(MODEL_CUSTODY_BACKFILL_COST.artifactBytes + 1, 0x41);
  const f = await fixture(tooLarge);

  await expect(readExactModelGeneration(f.env, f.generation)).rejects.toBeInstanceOf(RevisionCorrupt);
  expect(f.remote.counts.ranges).toContain(`bytes=0-${MODEL_CUSTODY_BACKFILL_COST.artifactBytes}`);
});
