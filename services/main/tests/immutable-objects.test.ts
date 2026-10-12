import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { clearVerifiedImmutableObjectCache, evictVerifiedImmutableObject, ObjectIntegrityError,
  ObjectNotFound, ObjectReadBudgetExceeded, ObjectUnavailable, S3ImmutableObjects }
  from '../src/infrastructure/immutable-objects.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { prepareComponent, prepareWorkComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readWorkComponentState, RevisionCorrupt } from '../src/modules/work/history.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
const directories: string[] = [];
afterEach(async () => {
  clearVerifiedImmutableObjectCache();
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeS3(options: { getStatus?: number; headStatus?: number; deleteStatus?: number;
  retainAfterDelete?: boolean; existingPutStatus?: 409 | 412; createdPutStatus?: number } = {}) {
  const data = new Map<string, Uint8Array>();
  const puts: { key: string; signedHeaders: string; checksum: string }[] = [];
  let bucketCreates = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'PUT' && url.pathname === '/rezics-semantic') {
      bucketCreates++;
      return new Response(null, { status: bucketCreates === 1 ? 200 : 409 });
    }
    if (request.method === 'HEAD' && url.pathname === '/rezics-semantic') {
      return new Response(null, { status: bucketCreates ? 200 : 404 });
    }
    const key = url.pathname.slice('/rezics-semantic/'.length);
    if (!url.pathname.startsWith('/rezics-semantic/')) return new Response(null, { status: 404 });
    if (request.method === 'PUT') {
      const auth = request.headers.get('authorization') ?? '';
      const checksum = request.headers.get('x-amz-checksum-sha256') ?? '';
      if (request.headers.get('if-none-match') !== '*' || !auth.startsWith('AWS4-HMAC-SHA256 ')) {
        return new Response(null, { status: 400 });
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (checksum !== Buffer.from(digest(bytes), 'hex').toString('base64')) {
        return new Response(null, { status: 400 });
      }
      puts.push({ key, signedHeaders: auth, checksum });
      if (data.has(key)) return new Response(null, { status: options.existingPutStatus ?? 412 });
      data.set(key, bytes);
      return new Response(null, { status: options.createdPutStatus ?? 200 });
    }
    if (request.method === 'DELETE') {
      if (options.deleteStatus !== undefined) return new Response(null, { status: options.deleteStatus });
      if (!options.retainAfterDelete) data.delete(key);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'HEAD') {
      if (options.headStatus !== undefined) return new Response(null, { status: options.headStatus });
      return new Response(null, { status: data.has(key) ? 200 : 404 });
    }
    if (request.method === 'GET') {
      if (options.getStatus !== undefined) return new Response(null, { status: options.getStatus });
      const bytes = data.get(key);
      return bytes ? new Response(Buffer.from(bytes), { status: 200 }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 405 });
  } });
  servers.push(server);
  const storeFor = (prefix: string) => new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
    prefix });
  return { store: storeFor('semantic/work/'), storeFor, data, puts,
    get bucketCreates() { return bucketCreates; } };
}

test('only an exact 404 proves an immutable object is missing', async () => {
  const absent = fakeS3();
  const missingDigest = digest(Buffer.from('missing object'));
  await expect(absent.store.probe(missingDigest)).rejects.toBeInstanceOf(ObjectNotFound);
  await expect(absent.store.get(missingDigest)).rejects.toBeInstanceOf(ObjectNotFound);

  for (const status of [403, 503]) {
    const unavailable = fakeS3({ getStatus: status, headStatus: status });
    for (const operation of [unavailable.store.probe(missingDigest), unavailable.store.get(missingDigest)]) {
      const error = await operation.then(() => undefined, caught => caught);
      expect(error).toBeInstanceOf(ObjectUnavailable);
      expect(error).not.toBeInstanceOf(ObjectNotFound);
    }
  }
});

test('non-ok immutable GET and HEAD responses retain numeric status without changing messages', async () => {
  const objectDigest = digest(Buffer.from('status-bearing immutable object'));
  for (const status of [403, 503]) {
    const unavailable = fakeS3({ getStatus: status, headStatus: status });
    const getError = await unavailable.store.get(objectDigest).then(() => undefined, error => error);
    expect(getError).toBeInstanceOf(ObjectUnavailable);
    expect(getError).toMatchObject({ status, message: `committed immutable object is unavailable (${status})` });
    const headError = await unavailable.store.probe(objectDigest).then(() => undefined, error => error);
    expect(headError).toBeInstanceOf(ObjectUnavailable);
    expect(headError).toMatchObject({ status,
      message: `committed immutable object probe is unavailable (${status})` });
  }

  const absent = fakeS3({ getStatus: 404, headStatus: 404 });
  const getError = await absent.store.get(objectDigest).then(() => undefined, error => error);
  expect(getError).toBeInstanceOf(ObjectNotFound);
  expect(getError).toMatchObject({ status: 404, message: 'committed immutable object was not found (404)' });
  const headError = await absent.store.probe(objectDigest).then(() => undefined, error => error);
  expect(headError).toBeInstanceOf(ObjectNotFound);
  expect(headError).toMatchObject({ status: 404, message: 'committed immutable object was not found (404)' });
});

test('a timed out immutable read is unavailable rather than absent', async () => {
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (request.method === 'HEAD' || request.method === 'GET') {
      requestStarted();
      return new Promise<Response>(() => {});
    }
    return new Response(null, { status: 404 });
  } });
  servers.push(server);
  const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
    prefix: 'semantic/work/', readSignal: () => AbortSignal.timeout(25) });
  const missingDigest = digest(Buffer.from('timed out object'));
  const pendingProbe = store.probe(missingDigest).then(() => undefined, error => error);
  await started;
  const probeError = await pendingProbe;
  expect(probeError).toBeInstanceOf(ObjectUnavailable);
  expect(probeError).not.toBeInstanceOf(ObjectNotFound);
  const readError = await store.get(missingDigest).then(() => undefined, error => error);
  expect(readError).toBeInstanceOf(ObjectUnavailable);
  expect(readError).not.toBeInstanceOf(ObjectNotFound);
});

test('a timed out delete is not reported as verified absence', async () => {
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (request.method === 'DELETE') {
      requestStarted();
      return new Promise<Response>(() => {});
    }
    return new Response(null, { status: 404 });
  } });
  servers.push(server);
  const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
    prefix: 'semantic/work/' });
  const missingDigest = digest(Buffer.from('timed out delete'));
  const pending = store.deleteAndVerifyAbsent(missingDigest, AbortSignal.timeout(25))
    .then(() => undefined, error => error);
  await started;
  const error = await pending;
  expect(error).toBeInstanceOf(ObjectUnavailable);
  expect(error).not.toBeInstanceOf(ObjectNotFound);
});

test('delete-and-readback proves absence and refuses a successful DELETE that leaves bytes', async () => {
  const removed = fakeS3();
  const bytes = Buffer.from('remove this object');
  const digestValue = await removed.store.put(bytes);
  await removed.store.deleteAndVerifyAbsent(digestValue);
  await expect(removed.store.get(digestValue)).rejects.toBeInstanceOf(ObjectNotFound);

  const retained = fakeS3({ retainAfterDelete: true });
  const retainedDigest = await retained.store.put(bytes);
  await expect(retained.store.deleteAndVerifyAbsent(retainedDigest)).rejects.toBeInstanceOf(ObjectUnavailable);
  expect(retained.data.has(`semantic/work/sha256/${retainedDigest}`)).toBe(true);
});

test('P0.5 signed conditional create verifies bytes before publishing a Work manifest', async () => {
  const { store, data, puts } = fakeS3();
  await store.initialize();
  const work = 'https://rezics.com/id/019f0000-0000-7000-8000-000000000001';
  const state = { mainVersion: 'https://rezics.com/id/019f0000-0000-7000-8000-000000000002',
    continuityProfile: 'https://rezics.com/definition/continuity/native-work-v1',
    title: 'Test Work', language: 'en' };
  const manifest = await prepareWorkComponent(store, work, state);
  const env: WorkActivationEnvironment = { workObjects: store, objectDirectory: '/nonexistent',
    fuseki: null as unknown as FusekiClient,
    lineage: { dataEpoch: 'test', routingEpoch: 'test' } };
  expect(await readWorkComponentState(env, `urn:rezics:sha256:${manifest}`, work)).toEqual(state);
  expect(data.size).toBe(2);
  expect(puts).toHaveLength(2);
  expect(puts.every(put => put.signedHeaders.includes('if-none-match')
    && put.signedHeaders.includes('x-amz-checksum-sha256'))).toBe(true);
  expect(await prepareWorkComponent(store, work, state)).toBe(manifest);
  expect(data.size).toBe(2);
});

test('P0.5 concurrent same-key writers converge and corrupt read-back fails closed', async () => {
  const { store, data, puts } = fakeS3();
  await store.initialize();
  const bytes = Buffer.from('same immutable bytes');
  const expected = digest(bytes);
  const results = await Promise.all(Array.from({ length: 12 }, () => store.put(bytes)));
  expect(results).toEqual(Array(12).fill(expected));
  expect(puts).toHaveLength(12);
  expect(data.size).toBe(1);
  expect(Buffer.from(await store.get(expected))).toEqual(bytes);
  data.set(`semantic/work/sha256/${expected}`, Buffer.from('tampered'));
  // A verified hit is not re-read. The store is authoritative again once that digest is dropped.
  expect(Buffer.from(await store.get(expected))).toEqual(bytes);
  evictVerifiedImmutableObject(expected);
  await expect(store.get(expected)).rejects.toBeInstanceOf(ObjectIntegrityError);
  await expect(store.put(bytes)).rejects.toBeInstanceOf(ObjectIntegrityError);
  const env: WorkActivationEnvironment = { workObjects: store, objectDirectory: '/nonexistent',
    fuseki: null as unknown as FusekiClient,
    lineage: { dataEpoch: 'test', routingEpoch: 'test' } };
  await expect(readWorkComponentState(env, `urn:rezics:sha256:${expected}`, 'work'))
    .rejects.toBeInstanceOf(RevisionCorrupt);
});

test('tracked conditional writes identify the sole creator and preserve existing digest keys', async () => {
  for (const existingPutStatus of [409, 412] as const) {
    const { store, data } = fakeS3({ existingPutStatus });
    const bytes = Buffer.from(`shared immutable bytes ${existingPutStatus}`);
    const expected = digest(bytes);
    const owned: string[] = [];
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      store.putTracked(bytes, undefined, created => { owned.push(created); })));
    expect(results.filter(result => result.created)).toEqual([{ digest: expected, created: true }]);
    expect(results.filter(result => !result.created)).toHaveLength(11);
    expect(results.every(result => result.digest === expected)).toBe(true);
    expect(owned).toEqual([expected]);
    expect(data.size).toBe(1);
    expect(await store.put(bytes)).toBe(expected);
  }
});

test('tracked create records ownership before failed read-back without claiming existing bytes', async () => {
  const { store, data } = fakeS3();
  const bytes = Buffer.from('created before read-back failure');
  const expected = digest(bytes);
  const owned: string[] = [];
  await expect(store.putTracked(bytes, undefined, created => {
    owned.push(created);
    // Corruption here also proves the notification precedes uncached read-back.
    data.set(`semantic/work/sha256/${created}`, Buffer.from('tampered read-back'));
  })).rejects.toBeInstanceOf(ObjectIntegrityError);
  expect(owned).toEqual([expected]);
  const existingOwned: string[] = [];
  await expect(store.putTracked(bytes, undefined, created => { existingOwned.push(created); }))
    .rejects.toBeInstanceOf(ObjectIntegrityError);
  expect(existingOwned).toEqual([]);
  expect(data.has(`semantic/work/sha256/${expected}`)).toBe(true);
});

test('an unsuccessful PUT acknowledgment never grants ownership even when bytes arrived', async () => {
  const { store, data } = fakeS3({ createdPutStatus: 503 });
  const bytes = Buffer.from('uncertain conditional create outcome');
  const owned: string[] = [];
  await expect(store.putTracked(bytes, undefined, created => { owned.push(created); }))
    .rejects.toBeInstanceOf(ObjectUnavailable);
  expect(owned).toEqual([]);
  expect(data.has(`semantic/work/sha256/${digest(bytes)}`)).toBe(true);
  expect(await store.putTracked(bytes)).toEqual({ digest: digest(bytes), created: false });
});

test('tracked PUT and its read-back respect a hard abort deadline and report only acknowledged ownership', async () => {
  for (const stalledMethod of ['PUT', 'GET']) {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      if (request.method === stalledMethod) return new Promise<Response>(() => {});
      return new Response(null, { status: 200 });
    } });
    servers.push(server);
    const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
      bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
      prefix: 'semantic/work/' });
    const bytes = Buffer.from(`deadline on ${stalledMethod}`);
    const owned: string[] = [];
    await expect(store.putTracked(bytes, AbortSignal.timeout(100), created => { owned.push(created); }))
      .rejects.toBeInstanceOf(ObjectUnavailable);
    expect(owned).toEqual(stalledMethod === 'GET' ? [digest(bytes)] : []);
  }
});

test('P0.5 equal bytes in different retention namespaces remain separate objects', async () => {
  const { store, storeFor, data } = fakeS3();
  await store.initialize();
  const privateStore = storeFor('semantic/private/');
  const bytes = Buffer.from('same bytes, distinct retention and disclosure');
  const expected = digest(bytes);
  expect(await store.put(bytes)).toBe(expected);
  expect(await privateStore.put(bytes)).toBe(expected);
  expect([...data.keys()].sort()).toEqual([
    `semantic/private/sha256/${expected}`, `semantic/work/sha256/${expected}`]);
});

test('bounded immutable reads accept the exact boundary and reject over-budget custody before returning bytes', async () => {
  const { store } = fakeS3();
  const bytes = Buffer.from('exact verified bytes');
  const expected = await store.put(bytes);
  expect(Buffer.from(await store.get(expected, bytes.length))).toEqual(bytes);
  await expect(store.get(expected, bytes.length - 1)).rejects.toBeInstanceOf(ObjectReadBudgetExceeded);
  await expect(store.get(expected, 0)).rejects.toBeInstanceOf(ObjectReadBudgetExceeded);
  expect(Buffer.from(await store.get(expected))).toEqual(bytes);
});

test('bounded immutable reads refuse a streamed object without a declared length', async () => {
  const bytes = Buffer.alloc(16_385, 65);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 8192));
      controller.enqueue(bytes.subarray(8192));
      controller.close();
    } }));
  } });
  servers.push(server);
  const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
    prefix: 'semantic/work/' });
  await expect(store.get(digest(bytes), 16_384)).rejects.toBeInstanceOf(ObjectReadBudgetExceeded);
});

test('P0.5 exact legacy Work references read verified local bytes during migration', async () => {
  const { store } = fakeS3();
  await store.initialize();
  const temp = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(temp, { recursive: true });
  const directory = mkdtempSync(`${temp}/p05-legacy-`); directories.push(directory);
  const work = 'https://rezics.com/id/019f0000-0000-7000-8000-000000000011';
  const state = { title: 'Legacy Work', language: 'en' };
  const manifest = prepareComponent(directory, work, state);
  const env: WorkActivationEnvironment = { workObjects: store, objectDirectory: directory,
    fuseki: null as unknown as FusekiClient,
    lineage: { dataEpoch: 'test', routingEpoch: 'test' } };
  expect(await readWorkComponentState(env, `urn:rezics:sha256:${manifest}`, work)).toEqual(state);
});
