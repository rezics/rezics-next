import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { hash, prepareComponent, prepareWorkComponent,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { readExactWorkRevision, readWorkComponentState, RevisionCorrupt, RevisionNotFound }
  from '../src/modules/work/history.ts';

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

const postProfile = 'https://rezics.com/definition/post-v1';
const native = () => `https://rezics.com/id/${randomUUID()}`;
const term = (value: string) => ({ type: 'uri', value });

async function retainedPost() {
  const post = native(), revision = native(), publisher = native();
  const objects = memoryObjects();
  const state = { publisher, labels: [{ value: 'Chapter title', language: 'en' },
    { value: 'Titre du chapitre', language: 'fr' }] };
  const manifest = await prepareWorkComponent(objects, post, state, postProfile);
  const row = { work: term(post), operation: term(native()), manifest: term(`urn:rezics:sha256:${manifest}`),
    model: term(postProfile), shape: term(postProfile), dataset: term('urn:rezics:dataset:product'),
    epoch: term(randomUUID()), sequence: term('17') };
  const current = { erased: false, ambiguous: false };
  const env = environment('.temp/unused-post-revision-mirror', objects);
  env.fuseki = { query: async (query: string) => {
    expect(query).toContain('a rv:RevisionAnchor');
    expect(query).toContain('a rv:ErasedRevision');
    return { results: { bindings: current.erased ? [] : current.ambiguous ? [row, row] : [row] } };
  } } as unknown as FusekiClient;
  return { env, post, revision, publisher, objects, state, row, current };
}

test('native Post exact history reads the actual publisher/labels manifest without inventing a MainVersion', async () => {
  const f = await retainedPost();
  const snapshot = await readExactWorkRevision(f.env, f.revision, async owner => owner === f.post);
  expect(snapshot).toMatchObject({ revision: f.revision, work: f.post, profile: 'post-v1',
    publisher: f.publisher, labels: f.state.labels, title: 'Chapter title', language: 'en',
    operation: f.row.operation.value, sourcePosition: { datasetId: 'product', dataEpoch: f.row.epoch.value, sequence: '17' } });
  expect(snapshot).not.toHaveProperty('mainVersion');
  expect(snapshot).not.toHaveProperty('semanticTypes');
});

test('native Post exact history refuses denied, erased, ambiguous and mismatched revision custody', async () => {
  const f = await retainedPost();
  await expect(readExactWorkRevision(f.env, f.revision, async () => false)).rejects.toBeInstanceOf(RevisionNotFound);
  f.current.erased = true;
  await expect(readExactWorkRevision(f.env, f.revision, async () => true)).rejects.toBeInstanceOf(RevisionNotFound);
  f.current.erased = false; f.current.ambiguous = true;
  await expect(readExactWorkRevision(f.env, f.revision, async () => true)).rejects.toBeInstanceOf(RevisionCorrupt);
  f.current.ambiguous = false;
  for (const mismatch of ['shape', 'component', 'payload', 'bytes'] as const) {
    const altered = await retainedPost();
    if (mismatch === 'shape') altered.row.shape = term('https://rezics.com/definition/work-metadata-v1');
    if (mismatch === 'component') altered.row.work = term(native());
    if (mismatch === 'payload') {
      const manifest = await prepareWorkComponent(altered.objects, altered.post,
        { publisher: altered.publisher, labels: [{ value: 'Invalid', language: 'en' }, { value: 'Duplicate', language: 'en' }] }, postProfile);
      altered.row.manifest = term(`urn:rezics:sha256:${manifest}`);
    }
    if (mismatch === 'bytes') altered.env.workObjects = { ...altered.objects, get: async () => Buffer.from('corrupt') };
    await expect(readExactWorkRevision(altered.env, altered.revision, async () => true)).rejects.toBeInstanceOf(RevisionCorrupt);
  }
});
