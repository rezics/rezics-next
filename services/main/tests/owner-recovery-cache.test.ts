import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { OwnerOperations } from '../src/modules/owner/operations.ts';
import {
  captureObjectRecoveryCoverage,
  ObjectRecoveryConflict,
  type ObjectRecoveryStore,
} from '../src/modules/owner/object-coverage.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import {
  STRUCTURE_MANIFEST_FORMAT,
  STRUCTURE_PAGE_FORMAT,
  STRUCTURE_PROFILE,
  type StructureManifest,
} from '../src/modules/structure/format.ts';
import {
  DATASET,
  GRAPHS,
  prepareComponent,
  prepareWorkComponent,
  PROFILE,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';
import { readExactWorkRevision } from '../src/modules/work/history.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
const directories: string[] = [];
let nextId = 1;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function id(): string {
  const value = nextId++;
  return `https://rezics.com/id/00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function localDirectory(name: string): string {
  const temp = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(temp, { recursive: true });
  const directory = mkdtempSync(`${temp}/${name}-`);
  directories.push(directory);
  return directory;
}

function fakeS3(prefix: 'semantic/work/' | 'semantic/structure/') {
  const data = new Map<string, Uint8Array>();
  const state: { corrupt: boolean; delayMs: number; onGet?: () => void } = {
    corrupt: false,
    delayMs: 0,
  };
  const counts = { gets: 0, ranges: [] as string[] };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'PUT' && url.pathname === '/rezics-semantic')
        return new Response(null, { status: 200 });
      if (request.method === 'HEAD' && url.pathname === '/rezics-semantic')
        return new Response(null, { status: 200 });
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
        if (state.corrupt) return new Response(Buffer.from('tampered'), { status: 200 });
        const bytes = data.get(key);
        return bytes ? new Response(Buffer.from(bytes), { status: 200 }) : new Response(null, { status: 404 });
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
  });
  return {
    store,
    state,
    counts,
    remove(digest: string) {
      data.delete(`${prefix}sha256/${digest}`);
    },
  };
}

function exactRevisionGraph(revision: string, work: string, manifestDigest: string) {
  return {
    query: async () => ({
      results: {
        bindings: [{
          work: { type: 'uri', value: work },
          operation: { type: 'uri', value: 'urn:test:operation' },
          manifest: { type: 'uri', value: `urn:rezics:sha256:${manifestDigest}` },
          model: { type: 'uri', value: PROFILE },
          shape: { type: 'uri', value: PROFILE },
          dataset: { type: 'uri', value: DATASET },
          epoch: { type: 'literal', value: 'test-epoch' },
          sequence: { type: 'literal', value: '1' },
        }],
      },
    }),
    revision,
  } as unknown as FusekiClient;
}

function coverageWorkGraph(work: string, manifestDigest: string) {
  const uri = (value: string) => ({ type: 'uri', value });
  return {
    query: async (query: string) => {
      if (query.includes('SELECT ?graph ?subject ?manifest')) {
        return { results: { bindings: [{
          graph: uri(GRAPHS.revisions),
          subject: uri(work),
          manifest: uri(`urn:rezics:sha256:${manifestDigest}`),
        }] } };
      }
      const value = query.includes('rv:component')
        ? work
        : query.includes('rv:modelRevision')
          ? PROFILE
          : PROFILE;
      return { results: { bindings: [{
        graph: uri(GRAPHS.revisions),
        subject: uri(work),
        value: uri(value),
      }] } };
    },
  } as unknown as FusekiClient;
}

function structureGraph(manifest: StructureManifest, manifestDigest: string) {
  const uri = (value: string) => ({ type: 'uri', value });
  const integer = (value: number) => ({
    type: 'literal',
    value: String(value),
    datatype: 'http://www.w3.org/2001/XMLSchema#integer',
  });
  const subject = id();
  return {
    subject,
    graph: {
      query: async (query: string) => {
        if (query.includes('SELECT ?graph ?subject ?manifest')) {
          return { results: { bindings: [{
            graph: uri(GRAPHS.revisions),
            subject: uri(subject),
            manifest: uri(`urn:rezics:sha256:${manifestDigest}`),
          }] } };
        }
        if (query.includes('SELECT ?manifest ?component ?generation ?count')) {
          return { results: { bindings: [{
            manifest: uri(`urn:rezics:sha256:${manifestDigest}`),
            component: uri(manifest.structure),
            generation: uri(manifest.generation),
            count: integer(manifest.placementCount),
          }] } };
        }
        const value = query.includes('rv:component')
          ? manifest.structure
          : query.includes('rv:modelRevision')
            ? STRUCTURE_PROFILE
            : STRUCTURE_PROFILE;
        return { results: { bindings: [{
          graph: uri(GRAPHS.revisions),
          subject: uri(subject),
          value: uri(value),
        }] } };
      },
    } as unknown as FusekiClient,
  };
}

function recoveryPool(): Pool {
  let record: { id: string; kind: string; scope: string; state: string } | undefined;
  let disposition: string | null = null;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes('SELECT pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes('SELECT pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      if (sql.includes('SELECT id, request_digest, state FROM relay.owner_reconciliation'))
        return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO relay.owner_reconciliation\n')) {
        record = { id: String(values[0]), kind: 'revision_recovery', scope: String(values[3]), state: 'running' };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO relay.owner_reconciliation_item')) {
        disposition = String(values[4]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE relay.owner_reconciliation SET state')) {
        if (record) record.state = String(values[1]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT id, kind, scope, state FROM relay.owner_reconciliation'))
        return { rows: record ? [record] : [], rowCount: record ? 1 : 0 };
      if (sql.includes('SELECT disposition FROM relay.owner_reconciliation_item'))
        return { rows: disposition ? [{ disposition }] : [], rowCount: disposition ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { connect: async () => client } as unknown as Pool;
}

async function workObjectsFixture(directory = localDirectory('owner-recovery-work')) {
  const remote = fakeS3('semantic/work/');
  const work = id();
  const state = { mainVersion: id(), title: 'Retained object', language: 'en' };
  const manifestDigest = await prepareWorkComponent(remote.store, work, state);
  const revision = id();
  const graph = exactRevisionGraph(revision, work, manifestDigest);
  return { remote, work, state, manifestDigest, revision, graph, directory };
}

function ownerOperations(f: Awaited<ReturnType<typeof workObjectsFixture>>) {
  const environment: WorkActivationEnvironment = {
    workObjects: f.remote.store,
    objectDirectory: f.directory,
    fuseki: f.graph,
    lineage: { dataEpoch: 'test-epoch', routingEpoch: 'test-routing' },
  };
  return new OwnerOperations(recoveryPool(), environment);
}

test('revision reconciliation sees a missing retained object after its digest was cached', async () => {
  const f = await workObjectsFixture();
  const exact = await readExactWorkRevision({
    workObjects: f.remote.store,
    objectDirectory: f.directory,
    fuseki: f.graph,
    lineage: { dataEpoch: 'test-epoch', routingEpoch: 'test-routing' },
  }, f.revision, async () => true);
  expect(exact.title).toBe(f.state.title);
  f.remote.remove(f.manifestDigest);
  const beforeReconciliation = f.remote.counts.gets;

  const result = await ownerOperations(f).reconcileRevision({ revision: f.revision }, 'missing-retained-object');

  expect(result.kind).toBe('revision_recovery');
  expect(result.state).toBe('held');
  expect(result.disposition).toBe('unavailable');
  expect(f.remote.counts.gets).toBeGreaterThan(beforeReconciliation);
});

test('revision reconciliation sees store corruption after its digest was cached', async () => {
  const f = await workObjectsFixture();
  const exact = await readExactWorkRevision({
    workObjects: f.remote.store,
    objectDirectory: f.directory,
    fuseki: f.graph,
    lineage: { dataEpoch: 'test-epoch', routingEpoch: 'test-routing' },
  }, f.revision, async () => true);
  expect(exact.title).toBe(f.state.title);
  f.remote.state.corrupt = true;
  const beforeReconciliation = f.remote.counts.gets;

  const result = await ownerOperations(f).reconcileRevision({ revision: f.revision }, 'corrupt-retained-object');

  expect(result.state).toBe('held');
  expect(result.disposition).toBe('corrupt');
  expect(f.remote.counts.gets).toBeGreaterThan(beforeReconciliation);
});

test('revision reconciliation keeps the verified local fallback when the selected store is unavailable', async () => {
  const directory = localDirectory('owner-recovery-fallback');
  const f = await workObjectsFixture(directory);
  const localDigest = prepareComponent(directory, f.work, f.state);
  expect(localDigest).toBe(f.manifestDigest);
  f.remote.remove(f.manifestDigest);

  const result = await ownerOperations(f).reconcileRevision({ revision: f.revision }, 'local-fallback');

  expect(result.state).toBe('reconciled');
  expect(result.disposition).toBe('matched');
});

test('object coverage reads valid Work bytes from the selected store without a local copy', async () => {
  const f = await workObjectsFixture();
  const graph = coverageWorkGraph(f.work, f.manifestDigest);
  const before = f.remote.counts.gets;
  const coverage = await captureObjectRecoveryCoverage(graph, {
    directory: f.directory,
    workObjects: f.remote.store,
  });

  expect(coverage.objectCount).toBe('2');
  expect(f.remote.counts.gets - before).toBe(2);
});

test('object coverage refuses a missing or corrupt cached Work object', async () => {
  const missing = await workObjectsFixture();
  const missingGraph = coverageWorkGraph(missing.work, missing.manifestDigest);
  await captureObjectRecoveryCoverage(missingGraph, {
    directory: missing.directory,
    workObjects: missing.remote.store,
  });
  missing.remote.remove(missing.manifestDigest);
  const beforeMissingRead = missing.remote.counts.gets;
  await expect(captureObjectRecoveryCoverage(missingGraph, {
    directory: missing.directory,
    workObjects: missing.remote.store,
  })).rejects.toMatchObject({ kind: 'unavailable' });
  expect(missing.remote.counts.gets).toBeGreaterThan(beforeMissingRead);

  const corrupt = await workObjectsFixture();
  const corruptGraph = coverageWorkGraph(corrupt.work, corrupt.manifestDigest);
  await captureObjectRecoveryCoverage(corruptGraph, {
    directory: corrupt.directory,
    workObjects: corrupt.remote.store,
  });
  corrupt.remote.state.corrupt = true;
  const beforeCorruptRead = corrupt.remote.counts.gets;
  const error = await captureObjectRecoveryCoverage(corruptGraph, {
    directory: corrupt.directory,
    workObjects: corrupt.remote.store,
  }).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ObjectRecoveryConflict);
  expect((error as ObjectRecoveryConflict).kind).toBe('corrupt');
  expect(corrupt.remote.counts.gets).toBeGreaterThan(beforeCorruptRead);
});

async function structureObjectsFixture() {
  const remote = fakeS3('semantic/structure/');
  const objects = remote.store;
  const cost = newCost();
  const indexed = recordTree(objects);
  const ordered = orderTree(objects);
  const manifest: StructureManifest = {
    format: STRUCTURE_MANIFEST_FORMAT,
    structure: id(),
    structureOf: id(),
    profile: 'book-composition',
    generation: id(),
    pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await indexed.empty(cost),
    order: await ordered.empty(cost),
    placementCount: 0,
    measures: [],
    model: STRUCTURE_PROFILE,
    shape: STRUCTURE_PROFILE,
  };
  const manifestDigest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const graph = structureGraph(manifest, manifestDigest).graph;
  const store: ObjectRecoveryStore = {
    directory: localDirectory('owner-recovery-structure'),
    structureObjects: objects,
    structureGroupRoots: { retainedRoots: async () => [] },
    structureQualifierRoots: { retainedRoots: async () => [] },
  };
  return { remote, manifest, manifestDigest, graph, store };
}

function structureQualification(options: { signal?: AbortSignal; maxBytes?: number } = {}) {
  return {
    signal: options.signal ?? new AbortController().signal,
    deadline: Date.now() + 30_000,
    maxProbes: 100,
    maxBytes: options.maxBytes ?? 16 * 1024 * 1024,
  };
}

test('Structure object coverage refuses a missing or corrupt cached object', async () => {
  const missing = await structureObjectsFixture();
  await captureObjectRecoveryCoverage(missing.graph, missing.store);
  missing.remote.remove(missing.manifestDigest);
  const beforeMissingRead = missing.remote.counts.gets;
  await expect(captureObjectRecoveryCoverage(missing.graph, missing.store)).rejects.toMatchObject({
    kind: 'unavailable',
  });
  expect(missing.remote.counts.gets).toBeGreaterThan(beforeMissingRead);

  const corrupt = await structureObjectsFixture();
  await captureObjectRecoveryCoverage(corrupt.graph, corrupt.store);
  corrupt.remote.state.corrupt = true;
  const beforeCorruptRead = corrupt.remote.counts.gets;
  const error = await captureObjectRecoveryCoverage(corrupt.graph, corrupt.store)
    .then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ObjectRecoveryConflict);
  expect((error as ObjectRecoveryConflict).kind).toBe('corrupt');
  expect(corrupt.remote.counts.gets).toBeGreaterThan(beforeCorruptRead);
});

test('Structure recovery preserves the association abort signal and byte cap on store reads', async () => {
  const aborted = await structureObjectsFixture();
  const controller = new AbortController();
  aborted.remote.state.delayMs = 40;
  aborted.remote.state.onGet = () => setTimeout(() => controller.abort(), 5);
  const beforeAbortRead = aborted.remote.counts.gets;
  const abortError = await captureObjectRecoveryCoverage(aborted.graph, {
    ...aborted.store,
    originalStructureAssociations: structureQualification({ signal: controller.signal }),
  }).then(() => undefined, (caught: unknown) => caught);
  expect(abortError).toBeInstanceOf(ObjectRecoveryConflict);
  expect((abortError as ObjectRecoveryConflict).kind).toBe('unavailable');
  expect(aborted.remote.counts.gets).toBeGreaterThan(beforeAbortRead);

  const bounded = await structureObjectsFixture();
  const beforeBoundedRead = bounded.remote.counts.gets;
  const boundedError = await captureObjectRecoveryCoverage(bounded.graph, {
    ...bounded.store,
    originalStructureAssociations: structureQualification({ maxBytes: 1 }),
  }).then(() => undefined, (caught: unknown) => caught);
  expect(boundedError).toBeInstanceOf(ObjectRecoveryConflict);
  expect((boundedError as ObjectRecoveryConflict).kind).toBe('unavailable');
  expect(bounded.remote.counts.gets).toBeGreaterThan(beforeBoundedRead);
  expect(bounded.remote.counts.ranges.at(-1)).toBe('bytes=0-1');
});

