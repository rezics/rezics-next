import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ObjectIntegrityError, ObjectNotFound, ObjectUnavailable, type ImmutableObjects }
  from '../src/infrastructure/immutable-objects.ts';
import { applyLiveObjectErasure, ObjectErasureConflict, objectErasureAbsent,
  replayObjectErasure } from '../src/modules/erasure/replay-objects.ts';
import type { ObjectRecoveryStore } from '../src/modules/owner/object-coverage.ts';

const directories: string[] = [];
const assetId = '019f0000-0000-7000-8000-000000000011';
const uploadId = '019f0000-0000-7000-8000-000000000012';

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function objectDirectory(): string {
  mkdirSync(resolve('.temp/erasure-live-private-objects'), { recursive: true });
  const directory = mkdtempSync(resolve('.temp/erasure-live-private-objects/objects-'));
  directories.push(directory);
  return directory;
}

function digest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

class MemoryObjects implements ImmutableObjects {
  readonly data = new Map<string, Uint8Array>();
  readonly deletes: string[] = [];
  probeFailure: Error | null = null;
  deleteFailure: Error | null = null;
  retainAfterDelete = false;

  async put(bytes: Uint8Array): Promise<string> {
    const value = digest(bytes);
    this.data.set(value, new Uint8Array(bytes));
    return value;
  }

  async get(value: string): Promise<Uint8Array> {
    const bytes = this.data.get(value);
    if (!bytes) throw new ObjectNotFound('missing');
    if (digest(bytes) !== value) throw new ObjectIntegrityError('corrupt');
    return new Uint8Array(bytes);
  }

  async probe(value: string): Promise<void> {
    if (this.probeFailure) throw this.probeFailure;
    if (!this.data.has(value)) throw new ObjectNotFound('missing');
  }

  async deleteAndVerifyAbsent(value: string): Promise<void> {
    this.deletes.push(value);
    if (this.deleteFailure) throw this.deleteFailure;
    if (!this.retainAfterDelete) this.data.delete(value);
    try {
      await this.probe(value);
    } catch (error) {
      if (error instanceof ObjectNotFound) return;
      throw error;
    }
    throw new ObjectUnavailable('object remains after delete');
  }
}

const emptyLiveProtection = { kind: 'live-bounded' as const, references: new Set<string>() };

test('erases a local Work object by its exact digest key', async () => {
  const directory = objectDirectory();
  const bytes = Buffer.from('local private payload');
  const value = digest(bytes);
  writeFileSync(join(directory, value), bytes);

  expect(await applyLiveObjectErasure({ directory }, `sha256:${value}`, emptyLiveProtection, true))
    .toBe('replayed');
  expect(existsSync(join(directory, value))).toBe(false);
});

test('erases a remote Work object by exact probe and verified delete', async () => {
  const directory = objectDirectory();
  const objects = new MemoryObjects();
  const value = await objects.put(Buffer.from('remote private payload'));

  expect(await replayObjectErasure({ directory, workObjects: objects }, `sha256:${value}`, new Set(), true))
    .toBe('replayed');
  expect(objects.deletes).toEqual([value]);
  expect(objects.data.has(value)).toBe(false);
});

test('a failure in one backend leaves the target conflicted and a retry finishes the same target', async () => {
  const directory = objectDirectory();
  const bytes = Buffer.from('local and remote copies');
  const value = digest(bytes);
  writeFileSync(join(directory, value), bytes);
  const remote = new MemoryObjects();
  remote.data.set(value, bytes);
  remote.deleteFailure = new ObjectUnavailable('remote delete failed');
  const store: ObjectRecoveryStore = { directory, workObjects: remote };

  expect(await applyLiveObjectErasure(store, `sha256:${value}`, emptyLiveProtection, true)).toBe('conflict');
  expect(existsSync(join(directory, value))).toBe(false);
  expect(remote.data.has(value)).toBe(true);

  remote.deleteFailure = null;
  expect(await applyLiveObjectErasure(store, `sha256:${value}`, emptyLiveProtection, true)).toBe('replayed');
  expect(remote.data.has(value)).toBe(false);
  expect(remote.deletes).toEqual([value, value]);
});

test('remote probe outages are not treated as object absence', async () => {
  const directory = objectDirectory();
  const remote = new MemoryObjects();
  remote.probeFailure = new ObjectUnavailable('remote probe failed');
  const store = { directory, workObjects: remote };

  await expect(objectErasureAbsent(store, `sha256:${'a'.repeat(64)}`)).rejects
    .toBeInstanceOf(ObjectUnavailable);
  expect(await replayObjectErasure(store, `sha256:${'a'.repeat(64)}`, new Set(), true)).toBe('conflict');
  expect(remote.deletes).toEqual([]);
});

test('validated Media asset and quarantine refs select only their exact namespaces', async () => {
  const directory = objectDirectory();
  const assetObjects = new MemoryObjects();
  const quarantineObjects = new MemoryObjects();
  const assetBytes = Buffer.from('private media original');
  const quarantineBytes = Buffer.from('quarantined private media');
  const assetDigest = await assetObjects.put(assetBytes);
  const quarantineDigest = await quarantineObjects.put(quarantineBytes);
  const requested: string[] = [];
  const store: ObjectRecoveryStore = {
    directory,
    mediaObjects: {
      asset: id => { requested.push(`asset:${id}`); return id === assetId ? assetObjects : undefined; },
      quarantine: id => { requested.push(`quarantine:${id}`); return id === uploadId ? quarantineObjects : undefined; },
    },
  };

  expect(await replayObjectErasure(store,
    `media-asset:v1:${assetId}:sha256:${assetDigest}`, new Set(), true)).toBe('replayed');
  expect(await replayObjectErasure(store,
    `media-quarantine:v1:${uploadId}:sha256:${quarantineDigest}`, new Set(), true)).toBe('replayed');
  expect(requested).toEqual([`asset:${assetId}`, `quarantine:${uploadId}`]);
  expect(assetObjects.data.size).toBe(0);
  expect(quarantineObjects.data.size).toBe(0);
});

test.each([
  'media-unknown:v1:019f0000-0000-7000-8000-000000000011:sha256:' + 'a'.repeat(64),
  `media-asset:v2:${assetId}:sha256:${'a'.repeat(64)}`,
  `media-quarantine:v1:${uploadId}:sha512:${'a'.repeat(128)}`,
])('refuses unknown namespace or reference version before touching storage: %s', async ref => {
  const directory = objectDirectory();
  const remote = new MemoryObjects();
  await expect(replayObjectErasure({ directory, workObjects: remote }, ref, new Set(), true)).rejects
    .toBeInstanceOf(ObjectErasureConflict);
  expect(remote.deletes).toEqual([]);
});

test('retains a shared object named by the bounded live protection set', async () => {
  const directory = objectDirectory();
  const bytes = Buffer.from('still referenced private component');
  const value = digest(bytes);
  writeFileSync(join(directory, value), bytes);
  const remote = new MemoryObjects();
  remote.data.set(value, bytes);
  const protection = { kind: 'live-bounded' as const, references: new Set([`sha256:${value}`]) };

  expect(await applyLiveObjectErasure({ directory, workObjects: remote }, `sha256:${value}`, protection, true))
    .toBe('conflict');
  expect(existsSync(join(directory, value))).toBe(true);
  expect(remote.data.has(value)).toBe(true);
  expect(remote.deletes).toEqual([]);
});

test('a successful DELETE that leaves the remote exact key present is not completion', async () => {
  const directory = objectDirectory();
  const remote = new MemoryObjects();
  const value = await remote.put(Buffer.from('retained after delete'));
  remote.retainAfterDelete = true;

  expect(await replayObjectErasure({ directory, workObjects: remote }, `sha256:${value}`, new Set(), true))
    .toBe('conflict');
  expect(remote.data.has(value)).toBe(true);
});
