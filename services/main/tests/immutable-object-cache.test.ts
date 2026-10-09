import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  clearVerifiedImmutableObjectCache, configureVerifiedImmutableObjectCache, evictVerifiedImmutableObject,
  ObjectIntegrityError, ObjectReadBudgetExceeded, ObjectUnavailable, rememberVerifiedImmutableObject,
  S3ImmutableObjects, VERIFIED_OBJECT_CACHE_DEFAULTS, verifiedImmutableObjectCacheMetrics,
} from '../src/infrastructure/immutable-objects.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readWorkComponentState, RevisionCorrupt } from '../src/modules/work/history.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
const directories: string[] = [];

beforeEach(() => clearVerifiedImmutableObjectCache());
afterEach(async () => {
  clearVerifiedImmutableObjectCache();
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeS3(options: { corrupt?: boolean } = {}) {
  const data = new Map<string, Uint8Array>();
  const counts = { gets: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'PUT' && url.pathname === '/rezics-semantic') return new Response(null, { status: 200 });
    if (request.method === 'HEAD' && url.pathname === '/rezics-semantic') return new Response(null, { status: 200 });
    const key = decodeURIComponent(url.pathname.slice('/rezics-semantic/'.length));
    if (!url.pathname.startsWith('/rezics-semantic/')) return new Response(null, { status: 404 });
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
      if (options.corrupt) return new Response(Buffer.from('tampered'), { status: 200 });
      const bytes = data.get(key);
      return bytes ? new Response(Buffer.from(bytes), { status: 200 }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 405 });
  } });
  servers.push(server);
  const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
    prefix: 'semantic/work/' });
  return { store, counts };
}

function environment(store: S3ImmutableObjects, directory: string): WorkActivationEnvironment {
  return { workObjects: store, objectDirectory: directory,
    fuseki: null as unknown as FusekiClient, lineage: { dataEpoch: 'test', routingEpoch: 'test' } };
}

function localDirectory(name: string): string {
  const temp = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(temp, { recursive: true });
  const directory = mkdtempSync(`${temp}/${name}-`);
  directories.push(directory);
  return directory;
}

test('verified object cache defaults stay bounded', () => {
  expect(VERIFIED_OBJECT_CACHE_DEFAULTS).toEqual({
    maxEntries: 512,
    maxTotalBytes: 32 * 1024 * 1024,
    maxObjectBytes: 1024 * 1024,
    ttlMs: 60_000,
  });
});

test('a cache hit returns the verified bytes without a store call', async () => {
  const { store, counts } = fakeS3();
  const bytes = Buffer.from('cached body');
  const digest = await store.put(bytes);
  const before = counts.gets;
  expect(Buffer.from(await store.get(digest))).toEqual(bytes);
  expect(Buffer.from(await store.get(digest))).toEqual(bytes);
  expect(counts.gets).toBe(before);
  expect(verifiedImmutableObjectCacheMetrics()).toEqual({ hits: 2, misses: 0 });
});

test('a body that fails verification is not cached and the error stays the same', async () => {
  const { store, counts } = fakeS3({ corrupt: true });
  const digest = digestOf(Buffer.from('expected body'));
  const first = await store.get(digest).then(() => undefined, error => error);
  const second = await store.get(digest).then(() => undefined, error => error);
  expect(first).toBeInstanceOf(ObjectIntegrityError);
  expect(second).toBeInstanceOf(ObjectIntegrityError);
  expect((second as Error).message).toBe((first as Error).message);
  expect((first as Error).message).toBe('immutable object digest differs');
  expect(counts.gets).toBe(2);
  expect(verifiedImmutableObjectCacheMetrics().hits).toBe(0);
});

test('a mismatched remember is ignored and a later read still fetches', async () => {
  const { store, counts } = fakeS3();
  const bytes = Buffer.from('real body');
  const digest = await store.put(bytes);
  evictVerifiedImmutableObject(digest);
  rememberVerifiedImmutableObject(digest, Buffer.from('not these bytes'));
  const before = counts.gets;
  expect(Buffer.from(await store.get(digest))).toEqual(bytes);
  expect(counts.gets).toBe(before + 1);
});

test('fallback bytes are cached only after the local file matches the digest', async () => {
  const { store, counts } = fakeS3();
  const directory = localDirectory('immutable-cache');
  const work = 'https://rezics.com/id/019f0000-0000-7000-8000-0000000000c1';
  const state = { title: 'Local zone', language: 'en' };
  const manifest = prepareComponent(directory, work, state);
  const env = environment(store, directory);
  expect(await readWorkComponentState(env, `urn:rezics:sha256:${manifest}`, work)).toEqual(state);
  const afterCold = counts.gets;
  expect(afterCold).toBe(1);
  expect(await readWorkComponentState(env, `urn:rezics:sha256:${manifest}`, work)).toEqual(state);
  expect(counts.gets).toBe(afterCold);
});

test('a corrupt store body still fails when a valid local file exists and is not cached', async () => {
  const { store, counts } = fakeS3({ corrupt: true });
  const directory = localDirectory('immutable-cache-corrupt');
  const work = 'https://rezics.com/id/019f0000-0000-7000-8000-0000000000c2';
  const manifest = prepareComponent(directory, work, { title: 'Local copy', language: 'en' });
  const env = environment(store, directory);
  const reference = `urn:rezics:sha256:${manifest}`;
  await expect(readWorkComponentState(env, reference, work)).rejects.toBeInstanceOf(RevisionCorrupt);
  const afterFirst = counts.gets;
  await expect(readWorkComponentState(env, reference, work)).rejects.toBeInstanceOf(RevisionCorrupt);
  expect(counts.gets).toBe(afterFirst + 1);
});

test('the entry bound evicts the least recently used digest', async () => {
  configureVerifiedImmutableObjectCache({ maxEntries: 2 });
  const { store, counts } = fakeS3();
  const first = await store.put(Buffer.from('one'));
  const second = await store.put(Buffer.from('two'));
  const third = await store.put(Buffer.from('three'));
  const before = counts.gets;
  expect(Buffer.from(await store.get(second))).toEqual(Buffer.from('two'));
  expect(Buffer.from(await store.get(third))).toEqual(Buffer.from('three'));
  expect(counts.gets).toBe(before);
  expect(Buffer.from(await store.get(first))).toEqual(Buffer.from('one'));
  expect(counts.gets).toBe(before + 1);
});

test('the byte bound evicts until the new object fits and an over-limit object is not stored', async () => {
  configureVerifiedImmutableObjectCache({ maxEntries: 8, maxTotalBytes: 30, maxObjectBytes: 20 });
  const { store, counts } = fakeS3();
  const first = await store.put(Buffer.from('0123456789abcdef'));
  const second = await store.put(Buffer.from('fedcba9876543210'));
  const before = counts.gets;
  expect(Buffer.from(await store.get(second))).toEqual(Buffer.from('fedcba9876543210'));
  expect(counts.gets).toBe(before);
  expect(Buffer.from(await store.get(first))).toEqual(Buffer.from('0123456789abcdef'));
  expect(counts.gets).toBe(before + 1);

  clearVerifiedImmutableObjectCache();
  configureVerifiedImmutableObjectCache({ maxObjectBytes: 4 });
  const large = fakeS3();
  const digest = await large.store.put(Buffer.from('too-long'));
  const fetched = large.counts.gets;
  expect(Buffer.from(await large.store.get(digest))).toEqual(Buffer.from('too-long'));
  expect(large.counts.gets).toBe(fetched + 1);
});

test('an expired entry is fetched again and a hit does not extend the TTL', async () => {
  let now = 1_000;
  configureVerifiedImmutableObjectCache({ ttlMs: 60_000, now: () => now });
  const { store, counts } = fakeS3();
  const digest = await store.put(Buffer.from('timed'));
  const afterPut = counts.gets;
  expect(Buffer.from(await store.get(digest))).toEqual(Buffer.from('timed'));
  now += 30_000;
  expect(Buffer.from(await store.get(digest))).toEqual(Buffer.from('timed'));
  expect(counts.gets).toBe(afterPut);
  now += 30_000;
  expect(Buffer.from(await store.get(digest))).toEqual(Buffer.from('timed'));
  expect(counts.gets).toBe(afterPut + 1);
});

test('discard and explicit eviction both drop the digest', async () => {
  const { store, counts } = fakeS3();
  const bytes = Buffer.from('evict me');
  const digest = await store.put(bytes);
  evictVerifiedImmutableObject(digest);
  const afterEvict = counts.gets;
  expect(Buffer.from(await store.get(digest))).toEqual(bytes);
  expect(counts.gets).toBe(afterEvict + 1);
  await store.discard(digest);
  const afterDiscard = counts.gets;
  await expect(store.get(digest)).rejects.toBeInstanceOf(ObjectUnavailable);
  expect(counts.gets).toBe(afterDiscard + 1);
});

test('a cached object still refuses a tighter read budget without a store call', async () => {
  const { store, counts } = fakeS3();
  const bytes = Buffer.from('exact verified bytes');
  const digest = await store.put(bytes);
  const before = counts.gets;
  expect(Buffer.from(await store.get(digest, bytes.length))).toEqual(bytes);
  await expect(store.get(digest, bytes.length - 1)).rejects.toBeInstanceOf(ObjectReadBudgetExceeded);
  expect(counts.gets).toBe(before);
});

test('a cache hit fails when the read deadline is already aborted', async () => {
  const bytes = Buffer.from('deadline');
  const expected = digestOf(bytes);
  const counts = { gets: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    counts.gets++;
    return new Response(Buffer.from(bytes));
  } });
  servers.push(server);
  const live = new AbortController();
  let deadline = live.signal;
  const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
    prefix: 'semantic/work/', readSignal: () => deadline });
  expect(Buffer.from(await store.get(expected))).toEqual(bytes);
  deadline = AbortSignal.abort(new DOMException('recovery deadline', 'TimeoutError'));
  const error = await store.get(expected).then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ObjectUnavailable);
  expect((error as Error).message).toBe('committed immutable object is unavailable');
  deadline = new AbortController().signal;
  const afterDeadline = counts.gets;
  expect(Buffer.from(await store.get(expected))).toEqual(bytes);
  expect(counts.gets).toBe(afterDeadline);
});

test('an aborted caller does not receive bytes', async () => {
  const { store, counts } = fakeS3();
  const digest = await store.put(Buffer.from('abort'));
  const before = counts.gets;
  await expect(store.get(digest, undefined, AbortSignal.abort())).rejects.toBeInstanceOf(ObjectUnavailable);
  expect(counts.gets).toBe(before);
});

test('concurrent first reads of one digest share a single fetch', async () => {
  const bytes = Buffer.from('shared fetch');
  const expected = digestOf(bytes);
  const data = new Map<string, Uint8Array>([[`semantic/work/sha256/${expected}`, bytes]]);
  const counts = { gets: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    counts.gets++;
    await Bun.sleep(40);
    const key = decodeURIComponent(new URL(request.url).pathname.slice('/rezics-semantic/'.length));
    const stored = data.get(key);
    return stored ? new Response(Buffer.from(stored), { status: 200 }) : new Response(null, { status: 404 });
  } });
  servers.push(server);
  const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
    prefix: 'semantic/work/' });
  const results = await Promise.all(Array.from({ length: 8 }, () => store.get(expected)));
  expect(results.every(item => Buffer.from(item).equals(bytes))).toBe(true);
  expect(counts.gets).toBe(1);
  const after = counts.gets;
  expect(Buffer.from(await store.get(expected))).toEqual(bytes);
  expect(counts.gets).toBe(after);
});
