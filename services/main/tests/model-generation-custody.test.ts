import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type CommandHealth, type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { protectedObjectDigests, replayObjectErasure } from '../src/modules/erasure/replay-objects.ts';
import { captureObjectRecoveryCoverage, ObjectRecoveryConflict } from '../src/modules/owner/object-coverage.ts';
import { ACTIVE_GENERATION, ensureModelGeneration, MODEL_MANIFEST_SHA256 } from '../src/modules/semantic/command.ts';
import { custodyGeneratedModelGeneration, custodyModelGenerationArtifacts, readExactModelGeneration, readPinnedRevisionModel } from '../src/modules/semantic/model-custody.ts';
import { MODEL_COMPONENT, PROFILES } from '../src/modules/semantic/schema.ts';
import { GRAPHS, hash, prepareWorkComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { RevisionCorrupt, RevisionNotFound, RevisionUnavailable } from '../src/modules/work/history.ts';

const modelDirectory = resolve(import.meta.dir, '../../../generated/model');
const manifestBytes = readFileSync(join(modelDirectory, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  profiles: { id: string; sha256: string; file: string }[];
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class MemoryObjects implements ImmutableObjects {
  readonly data = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  failDigest?: string;
  returnWrongDigest = false;

  async put(bytes: Uint8Array): Promise<string> {
    const digest = hash(bytes);
    this.puts.push(digest);
    if (digest === this.failDigest) throw new ObjectUnavailable('custody unavailable');
    const previous = this.data.get(digest);
    if (previous && hash(previous) !== digest) throw new ObjectIntegrityError('existing custody object is corrupt');
    this.data.set(digest, new Uint8Array(bytes));
    return this.returnWrongDigest ? '0'.repeat(64) : digest;
  }

  async get(digest: string): Promise<Uint8Array> {
    const bytes = this.data.get(digest);
    if (!bytes) throw new ObjectUnavailable('custody object is missing');
    return new Uint8Array(bytes);
  }
}

class ModelGraph extends FusekiClient {
  readonly commands: CommandEnvelope[] = [];
  readonly queries: string[] = [];
  readonly generations = new Map<string, { manifest: string; commandModule: string }>();
  readonly revisionPins = new Map<string, string>();
  active = false;
  lostResponse = false;
  beforeCommit?: () => void;

  constructor() { super('http://unused.invalid'); }

  override async commandHealth(): Promise<CommandHealth> {
    return { moduleVersion: COMMAND_MODULE_VERSION, instanceId: 'fixture', publicSearchWriteEpoch: '1',
      publicSearchWriteActive: true, profiles: Object.fromEntries(
        Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) };
  }

  override async query(query: string): Promise<SparqlResult> {
    this.queries.push(query);
    const term = (value: string) => ({ type: 'uri', value });
    if (query.includes('SELECT ?graph ?subject ?manifest')) {
      return { results: { bindings: [...this.generations].map(([generation, anchor]) => ({
        graph: term(GRAPHS.revisions), subject: term(generation), manifest: term(anchor.manifest),
      })) } };
    }
    if (query.includes('SELECT ?graph ?subject ?value')) {
      const value = query.includes('rv:component') ? MODEL_COMPONENT : PROFILES.generation;
      return { results: { bindings: [...this.generations].map(([generation]) => ({
        graph: term(GRAPHS.revisions), subject: term(generation), value: term(value),
      })) } };
    }
    if (query.includes('SELECT ?generation')) {
      const pin = [...this.revisionPins].find(([revision]) => query.includes(`<${revision}>`));
      return { results: { bindings: pin ? [{ generation: term(pin[1]) }] : [] } };
    }
    if (query.includes('SELECT ?manifest ?commandModule')) {
      const generation = [...this.generations].find(([id]) => query.includes(`<${id}>`));
      return { results: { bindings: generation ? [{ manifest: term(generation[1].manifest),
        commandModule: term(generation[1].commandModule) }] : [] } };
    }
    return { boolean: query.includes('FILTER NOT EXISTS') ? false : this.active };
  }

  override async commandWithReceipt(command: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(command);
    this.beforeCommit?.();
    if (this.active) return { status: 'guard-unmatched' };
    const anchorManifest = /rv:manifest <(urn:rezics:sha256:[0-9a-f]{64})>/.exec(command.update)?.[1];
    if (!anchorManifest) throw new Error('model activation omitted its retained manifest');
    this.generations.set(ACTIVE_GENERATION, { manifest: anchorManifest, commandModule: COMMAND_MODULE_VERSION });
    this.active = true;
    if (this.lostResponse) throw new Error('lost activation response');
    return { status: 'committed', position: { datasetId: 'product', dataEpoch: 'epoch', sequence: '1' } };
  }
}

function fixture(objects: MemoryObjects | null = new MemoryObjects()) {
  mkdirSync(resolve('.temp/model-custody-tests'), { recursive: true });
  const directory = mkdtempSync(resolve('.temp/model-custody-tests/objects-'));
  directories.push(directory);
  const graph = new ModelGraph();
  const env: WorkActivationEnvironment = { fuseki: graph, objectDirectory: directory,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, ...(objects ? { workObjects: objects } : {}) };
  return { env, graph, directory, objects };
}

test('activation custodies the exact manifest and every shape by digest before graph publication', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  f.graph.beforeCommit = () => {
    expect(objects.data.get(MODEL_MANIFEST_SHA256)).toEqual(new Uint8Array(manifestBytes));
    for (const profile of manifest.profiles) {
      expect(objects.data.get(profile.sha256)).toEqual(new Uint8Array(readFileSync(join(modelDirectory, profile.file))));
    }
  };
  expect(await ensureModelGeneration(f.env)).toBe(ACTIVE_GENERATION);
  const exact = await readExactModelGeneration(f.env, ACTIVE_GENERATION);
  expect(exact.manifestSha256).toBe(MODEL_MANIFEST_SHA256);
  expect(exact.manifest).toEqual(new Uint8Array(manifestBytes));
  expect(exact.shapes.map(shape => shape.profile)).toEqual(manifest.profiles.map(profile => profile.id));
  expect(exact.shapes.every(shape => hash(shape.bytes) === shape.sha256)).toBe(true);
  expect(f.graph.commands).toHaveLength(1);
});

test('a pinned revision reads its old generation after a later model becomes current', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  const shape = Buffer.from('@prefix sh: <http://www.w3.org/ns/shacl#> . <urn:old:shape> a sh:NodeShape .\n');
  const oldManifest = Buffer.from(JSON.stringify({ commandModule: '0.5.1', profiles: [
    { id: 'retained-profile-v1', sha256: hash(shape), file: 'shapes/retained-profile-v1.ttl' },
  ] }));
  const oldGeneration = `urn:rezics:model-generation:${hash(oldManifest)}`;
  await custodyModelGenerationArtifacts(f.env, oldGeneration, oldManifest, () => shape);
  const anchor = await prepareWorkComponent(objects, oldGeneration, {
    modelManifestSha256: hash(oldManifest), commandModule: '0.5.1', entailment: 'none',
  }, PROFILES.generation);
  f.graph.generations.set(oldGeneration, { manifest: `urn:rezics:sha256:${anchor}`, commandModule: '0.5.1' });
  const revision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
  f.graph.revisionPins.set(revision, oldGeneration);
  await ensureModelGeneration(f.env);
  f.graph.queries.length = 0;
  const exact = await readPinnedRevisionModel(f.env, revision);
  expect(exact.generation).toBe(oldGeneration);
  expect(exact.commandModule).toBe('0.5.1');
  expect(exact.manifest).toEqual(new Uint8Array(oldManifest));
  expect(exact.shapes).toEqual([{ profile: 'retained-profile-v1', sha256: hash(shape), bytes: new Uint8Array(shape) }]);
  expect(f.graph.queries.every(query => !query.includes('generationHead'))).toBe(true);
  const store = { directory: f.directory, workObjects: objects };
  const retained = new Set<string>();
  const coverage = await captureObjectRecoveryCoverage(f.graph, store, retained);
  expect(coverage.anchorCount).toBe('2');
  expect(coverage.objectCount).toBe(String(objects.data.size));
  const protectedDigests = await protectedObjectDigests(f.graph, store);
  expect(protectedDigests).toEqual(retained);
  for (const digest of [hash(oldManifest), hash(shape)]) {
    expect(protectedDigests.has(digest)).toBe(true);
    expect(await replayObjectErasure(store, `sha256:${digest}`, protectedDigests, true)).toBe('conflict');
  }
  objects.data.delete(hash(shape));
  await expect(captureObjectRecoveryCoverage(f.graph, store)).rejects.toBeInstanceOf(ObjectRecoveryConflict);
});

for (const [artifact, digest] of [['shape', manifest.profiles[1]!.sha256], ['manifest', MODEL_MANIFEST_SHA256]] as const) {
  test(`failed ${artifact} custody prevents activation and retries after recovery`, async () => {
    const objects = new MemoryObjects();
    const f = fixture(objects);
    objects.failDigest = digest;
    await expect(ensureModelGeneration(f.env)).rejects.toBeInstanceOf(ObjectUnavailable);
    expect(objects.data.has(MODEL_MANIFEST_SHA256)).toBe(false);
    expect(f.graph.commands).toHaveLength(0);
    expect(f.graph.active).toBe(false);
    objects.failDigest = undefined;
    expect(await ensureModelGeneration(f.env)).toBe(ACTIVE_GENERATION);
    expect(f.graph.commands).toHaveLength(1);
  });
}

test('custody acknowledgement with the wrong digest fails before activation', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  objects.returnWrongDigest = true;
  await expect(ensureModelGeneration(f.env)).rejects.toBeInstanceOf(RevisionCorrupt);
  expect(f.graph.commands).toHaveLength(0);
});

test('concurrent activation shares artifact custody and a lost graph response resolves the same generation', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  f.graph.lostResponse = true;
  expect(await Promise.all([ensureModelGeneration(f.env), ensureModelGeneration(f.env)])).toEqual([
    ACTIVE_GENERATION, ACTIVE_GENERATION,
  ]);
  expect(objects.puts.filter(digest => digest === MODEL_MANIFEST_SHA256)).toHaveLength(1);
  expect(new Set(f.graph.commands.map(command => command.receipt)).size).toBe(1);
  const puts = objects.puts.length;
  await ensureModelGeneration(f.env);
  expect(objects.puts).toHaveLength(puts);
});

test('an already recorded build backfills custody and refuses success while storage is unavailable', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  f.graph.active = true;
  objects.failDigest = MODEL_MANIFEST_SHA256;
  await expect(ensureModelGeneration(f.env)).rejects.toBeInstanceOf(ObjectUnavailable);
  expect(f.graph.commands).toHaveLength(0);
  objects.failDigest = undefined;
  expect(await ensureModelGeneration(f.env)).toBe(ACTIVE_GENERATION);
  expect(objects.data.has(MODEL_MANIFEST_SHA256)).toBe(true);
  expect(f.graph.commands).toHaveLength(0);
});

test('a retained manifest or shape that disappears makes exact reads unavailable', async () => {
  for (const digest of [MODEL_MANIFEST_SHA256, manifest.profiles[0]!.sha256]) {
    const objects = new MemoryObjects();
    const f = fixture(objects);
    await ensureModelGeneration(f.env);
    objects.data.delete(digest);
    await expect(readExactModelGeneration(f.env, ACTIVE_GENERATION)).rejects.toBeInstanceOf(RevisionUnavailable);
  }
});

test('corrupt retained artifacts and a mismatched generation state fail exact reads', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  await ensureModelGeneration(f.env);
  const shapeDigest = manifest.profiles[0]!.sha256;
  const original = objects.data.get(shapeDigest)!;
  objects.data.set(shapeDigest, Buffer.from('corrupt shape'));
  await expect(readExactModelGeneration(f.env, ACTIVE_GENERATION)).rejects.toBeInstanceOf(RevisionCorrupt);
  objects.data.set(shapeDigest, original);
  const anchor = await prepareWorkComponent(objects, ACTIVE_GENERATION, {
    modelManifestSha256: 'a'.repeat(64), commandModule: COMMAND_MODULE_VERSION, entailment: 'none',
  }, PROFILES.generation);
  f.graph.generations.set(ACTIVE_GENERATION, { manifest: `urn:rezics:sha256:${anchor}`, commandModule: COMMAND_MODULE_VERSION });
  await expect(readExactModelGeneration(f.env, ACTIVE_GENERATION)).rejects.toBeInstanceOf(RevisionCorrupt);
});

test('missing or ambiguous model anchors and revision pins fail exact reads', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  await expect(readExactModelGeneration(f.env, ACTIVE_GENERATION)).rejects.toBeInstanceOf(RevisionNotFound);
  await ensureModelGeneration(f.env);
  const revision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
  f.graph.revisionPins.set(revision, ACTIVE_GENERATION);
  const originalQuery = f.graph.query.bind(f.graph);
  let duplicateAnchors = true;
  f.graph.query = async query => {
    const result = await originalQuery(query);
    if ((duplicateAnchors && query.includes('SELECT ?manifest ?commandModule'))
      || (!duplicateAnchors && query.includes('SELECT ?generation'))) {
      const first = result.results?.bindings[0];
      return { results: { bindings: first ? [first, first] : [] } };
    }
    return result;
  };
  await expect(readExactModelGeneration(f.env, ACTIVE_GENERATION)).rejects.toBeInstanceOf(RevisionCorrupt);
  duplicateAnchors = false;
  await expect(readPinnedRevisionModel(f.env, revision)).rejects.toBeInstanceOf(RevisionCorrupt);
});

test('a graph command-module mismatch makes the exact retained model corrupt', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  await ensureModelGeneration(f.env);
  const anchor = f.graph.generations.get(ACTIVE_GENERATION)!;
  f.graph.generations.set(ACTIVE_GENERATION, { ...anchor, commandModule: 'unexpected-module' });
  await expect(readExactModelGeneration(f.env, ACTIVE_GENERATION)).rejects.toBeInstanceOf(RevisionCorrupt);
});

test('an active-build manifest for another command module is rejected before custody publication', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(manifestBytes.toString('utf8')),
    commandModule: 'unexpected-module' }));
  await expect(custodyGeneratedModelGeneration(f.env, `urn:rezics:model-generation:${hash(bytes)}`,
    bytes, modelDirectory)).rejects.toThrow('command module differs');
  expect(objects.puts).toHaveLength(0);
});

test('custody refuses changed shape bytes and unsafe or duplicate profile identities', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  await expect(custodyModelGenerationArtifacts(f.env, ACTIVE_GENERATION, manifestBytes,
    () => Buffer.from('changed shape'))).rejects.toBeInstanceOf(RevisionCorrupt);
  const profile = { id: 'test-v1', sha256: 'a'.repeat(64), file: 'shapes/test-v1.ttl' };
  for (const profiles of [[{ ...profile, file: '../outside.ttl' }], [profile, profile]]) {
    const bytes = Buffer.from(JSON.stringify({ commandModule: '1', profiles }));
    await expect(custodyModelGenerationArtifacts(f.env, `urn:rezics:model-generation:${hash(bytes)}`,
      bytes, () => Buffer.from('shape'))).rejects.toBeInstanceOf(RevisionCorrupt);
  }
  expect(objects.puts).toHaveLength(0);
  await expect(readPinnedRevisionModel(f.env, `https://rezics.com/id/${Bun.randomUUIDv7()}`)).rejects.toBeInstanceOf(RevisionNotFound);
});

test('filesystem fixtures custody identical digest objects and read the exact model', async () => {
  const f = fixture(null);
  await ensureModelGeneration(f.env);
  expect(readFileSync(join(f.directory, MODEL_MANIFEST_SHA256))).toEqual(manifestBytes);
  const exact = await readExactModelGeneration(f.env, ACTIVE_GENERATION);
  expect(exact.shapes).toHaveLength(manifest.profiles.length);
  for (const shape of exact.shapes) expect(hash(readFileSync(join(f.directory, shape.sha256)))).toBe(shape.sha256);
});

test('recovery and erasure retention include every exact model artifact and reject missing custody', async () => {
  const objects = new MemoryObjects();
  const f = fixture(objects);
  await ensureModelGeneration(f.env);
  const store = { directory: f.directory, workObjects: objects };
  const retained = new Set<string>();
  const coverage = await captureObjectRecoveryCoverage(f.graph, store, retained);
  expect(coverage.objectCount).toBe(String(objects.data.size));
  expect(retained.has(MODEL_MANIFEST_SHA256)).toBe(true);
  for (const profile of manifest.profiles) expect(retained.has(profile.sha256)).toBe(true);
  const protectedDigests = await protectedObjectDigests(f.graph, store);
  expect(protectedDigests).toEqual(retained);
  expect(await replayObjectErasure(store, `sha256:${MODEL_MANIFEST_SHA256}`, protectedDigests, true)).toBe('conflict');
  expect(await replayObjectErasure(store, `sha256:${manifest.profiles[0]!.sha256}`, protectedDigests, true)).toBe('conflict');
  objects.data.delete(manifest.profiles[0]!.sha256);
  await expect(captureObjectRecoveryCoverage(f.graph, store)).rejects.toBeInstanceOf(ObjectRecoveryConflict);
});
