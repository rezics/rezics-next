import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { S3ImmutableObjects, ObjectIntegrityError } from '../src/infrastructure/immutable-objects.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { prepareComponent, prepareWorkComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readWorkComponentState, RevisionCorrupt } from '../src/modules/work/history.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeS3() {
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
      if (data.has(key)) return new Response(null, { status: 412 });
      data.set(key, bytes);
      return new Response(null, { status: 200 });
    }
    if (request.method === 'GET') {
      const bytes = data.get(key);
      return bytes ? new Response(Buffer.from(bytes), { status: 200 }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 405 });
  } });
  servers.push(server);
  const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
    bucket: 'rezics-semantic', accessKeyId: 'local-test-key', secretAccessKey: 'local-test-secret',
    prefix: 'semantic/work/' });
  return { store, data, puts, get bucketCreates() { return bucketCreates; } };
}

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
  await expect(store.get(expected)).rejects.toBeInstanceOf(ObjectIntegrityError);
  const env: WorkActivationEnvironment = { workObjects: store, objectDirectory: '/nonexistent',
    fuseki: null as unknown as FusekiClient,
    lineage: { dataEpoch: 'test', routingEpoch: 'test' } };
  await expect(readWorkComponentState(env, `urn:rezics:sha256:${expected}`, 'work'))
    .rejects.toBeInstanceOf(RevisionCorrupt);
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
