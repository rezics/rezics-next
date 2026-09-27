import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { hash, prepareComponent, prepareWorkComponent,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readWorkComponentState, RevisionCorrupt } from '../src/modules/work/history.ts';

const root = resolve(import.meta.dir, '../../..');
const work = `https://rezics.com/id/${randomUUID()}`;

function memoryObjects(): ImmutableObjects {
  const stored = new Map<string, Uint8Array>();
  return {
    async put(bytes) {
      const digest = hash(bytes);
      stored.set(digest, new Uint8Array(bytes));
      return digest;
    },
    async get(digest) {
      const bytes = stored.get(digest);
      if (!bytes) throw new ObjectUnavailable('object is absent');
      return bytes;
    },
  };
}

function environment(directory: string, workObjects: ImmutableObjects): WorkActivationEnvironment {
  return { fuseki: new FusekiClient('http://127.0.0.1:1/rezics/'),
    lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    objectDirectory: directory, workObjects };
}

test('configured Work revision reader uses verified object-store bytes without a local mirror', async () => {
  const directory = join(root, '.temp', `revision-read-${randomUUID()}`);
  const objects = memoryObjects();
  const state = { title: 'stored remotely' };
  const manifest = await prepareWorkComponent(objects, work, state);
  expect(await readWorkComponentState(environment(directory, objects),
    `urn:rezics:sha256:${manifest}`, work)).toEqual(state);
  expect(existsSync(directory)).toBe(false);
});

test('configured Work revision reader rejects wrong bytes even if a local copy is valid', async () => {
  const directory = join(root, '.temp', `revision-read-${randomUUID()}`);
  const state = { title: 'local copy' };
  try {
    const manifest = prepareComponent(directory, work, state);
    const objects: ImmutableObjects = {
      async put(bytes) { return hash(bytes); },
      async get() { return Buffer.from('wrong bytes'); },
    };
    await expect(readWorkComponentState(environment(directory, objects),
      `urn:rezics:sha256:${manifest}`, work)).rejects.toBeInstanceOf(RevisionCorrupt);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('configured Work revision reader retains verified directory revisions', async () => {
  const directory = join(root, '.temp', `revision-read-${randomUUID()}`);
  const state = { title: 'legacy revision' };
  try {
    const manifest = prepareComponent(directory, work, state);
    expect(await readWorkComponentState(environment(directory, memoryObjects()),
      `urn:rezics:sha256:${manifest}`, work)).toEqual(state);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
