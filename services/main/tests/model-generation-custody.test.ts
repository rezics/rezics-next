import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { modelCustodyArguments } from '../../../scripts/datasets/model-bootstrap.ts';
import { FusekiClient, type CommandEnvelope, type CommandHealth, type CommandResult, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import { protectedObjectDigests, replayObjectErasure } from '../src/modules/erasure/replay-objects.ts';
import { captureObjectRecoveryCoverage, ObjectRecoveryConflict } from '../src/modules/owner/object-coverage.ts';
import { ACTIVE_GENERATION, ensureModelGeneration, MODEL_MANIFEST_SHA256 } from '../src/modules/semantic/command.ts';
import { backfillRetainedModelCustody, custodyGeneratedModelGeneration, custodyModelGenerationArtifacts,
  ModelCustodyBackfillConflict, ModelCustodyBackfillDeadline,
  readExactModelGeneration, readPinnedRevisionModel } from '../src/modules/semantic/model-custody.ts';
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
  readonly gets: string[] = [];
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
    this.gets.push(digest);
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
  head = ACTIVE_GENERATION;
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
    if (query.includes('SELECT ?head')) {
      return { results: { bindings: this.active ? [{ head: term(this.head) }] : [] } };
    }
    if (query.includes('SELECT ?generation ?manifest ?commandModule')) {
      const cursor = /(?:STR\(\?generation\)|\?generation)\s*>\s*(<[^>]+>|"(?:[^"\\]|\\.)*")/.exec(query)?.[1];
      const after = cursor?.startsWith('<') ? cursor.slice(1, -1) : cursor ? JSON.parse(cursor) as string : null;
      const limit = Number(/LIMIT\s+(\d+)/i.exec(query)?.[1] ?? this.generations.size);
      const generations = [...this.generations].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .filter(([generation]) => after === null || generation > after).slice(0, limit);
      return { results: { bindings: generations.map(([generation, anchor]) => ({ generation: term(generation),
        manifest: term(anchor.manifest), commandModule: { type: 'literal', value: anchor.commandModule } })) } };
    }
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
    this.head = ACTIVE_GENERATION;
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

type BackfillCheckpoint = Awaited<ReturnType<typeof backfillRetainedModelCustody>>;

async function retainedOriginalBuild(f: ReturnType<typeof fixture>, objects: MemoryObjects,
  name: string, commandModule = '0.4.1', shapeCount = 2) {
  const directory = join(f.directory, `build-${name}`);
  mkdirSync(join(directory, 'shapes'), { recursive: true });
  const profiles = Array.from({ length: shapeCount }, (_, index) => {
    const id = `${name}-profile-${index}-v1`;
    const bytes = Buffer.from(`@prefix sh: <http://www.w3.org/ns/shacl#> . <urn:${id}:shape> a sh:NodeShape .\n`);
    const file = `shapes/${id}.ttl`;
    writeFileSync(join(directory, file), bytes);
    return { id, file, sha256: hash(bytes), bytes };
  });
  const bytes = Buffer.from(JSON.stringify({ commandModule,
    profiles: profiles.map(({ id, file, sha256 }) => ({ id, file, sha256 })) }));
  writeFileSync(join(directory, 'manifest.json'), bytes);
  const generation = `urn:rezics:model-generation:${hash(bytes)}`;
  const anchor = await prepareWorkComponent(objects, generation, {
    modelManifestSha256: hash(bytes), commandModule, entailment: 'none',
  }, PROFILES.generation);
  f.graph.generations.set(generation, { manifest: `urn:rezics:sha256:${anchor}`, commandModule });
  const revision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
  f.graph.revisionPins.set(revision, generation);
  f.graph.active = true;
  f.graph.head = generation;
  return { directory, generation, commandModule, profiles, bytes, revision };
}

const backfillOptions = (buildDirectories: string[]) => ({ buildDirectories,
  sourceKey: 'retained-model-unit', now: () => 1000 });

test('retained original builds backfill in bounded turns without changing later heads or model pins', async () => {
  const objects = new MemoryObjects(), f = fixture(objects);
  const old = await retainedOriginalBuild(f, objects, 'older');
  const later = await retainedOriginalBuild(f, objects, 'later', '0.4.2');
  const roots = [later.directory, old.directory];
  const anchors = [...f.graph.generations], pins = [...f.graph.revisionPins];
  const store = { directory: f.directory, workObjects: objects };
  await expect(captureObjectRecoveryCoverage(f.graph, store)).rejects.toBeInstanceOf(ObjectRecoveryConflict);
  const progress: BackfillCheckpoint[] = [];
  let checkpoint = await backfillRetainedModelCustody(f.env, { ...backfillOptions(roots), maxObjects: 1 },
    value => { progress.push(structuredClone(value)); });
  expect(progress[0]!.objects).toBe(0);
  expect(progress.at(-1)!.objects).toBe(1);
  expect(checkpoint.objects).toBe(1);
  expect(checkpoint.generations).toBe(0);
  expect(checkpoint.complete).toBe(false);
  expect(checkpoint.pending).toEqual({ generation: [old.generation, later.generation].sort()[0], nextArtifact: 1 });
  for (let turn = 0; !checkpoint.complete && turn < 8; turn++) {
    const previous = checkpoint.objects;
    checkpoint = await backfillRetainedModelCustody(f.env, {
      ...backfillOptions(roots), checkpoint, maxObjects: 1,
    });
    expect(checkpoint.objects - previous).toBeLessThanOrEqual(1);
  }
  expect(checkpoint).toMatchObject({ complete: true, generations: 2, objects: 6, pending: null, head: later.generation });
  for (const build of [old, later]) {
    const root = hash(build.bytes);
    expect(objects.data.get(root)).toEqual(new Uint8Array(build.bytes));
    for (const profile of build.profiles) {
      expect(objects.data.get(profile.sha256)).toEqual(new Uint8Array(profile.bytes));
      expect(objects.puts.indexOf(profile.sha256)).toBeLessThan(objects.puts.indexOf(root));
    }
  }
  expect(await readPinnedRevisionModel(f.env, old.revision)).toMatchObject({ generation: old.generation,
    commandModule: old.commandModule, manifest: new Uint8Array(old.bytes) });
  expect(await readPinnedRevisionModel(f.env, later.revision)).toMatchObject({ generation: later.generation,
    commandModule: later.commandModule, manifest: new Uint8Array(later.bytes) });
  const puts = objects.puts.length;
  const replay = await backfillRetainedModelCustody(f.env, { ...backfillOptions(roots), checkpoint });
  expect(replay).toMatchObject({ complete: true, generations: 2, objects: 6 });
  expect((await backfillRetainedModelCustody(f.env, { ...backfillOptions(roots), maxObjects: 64 })).complete).toBe(true);
  expect(objects.puts).toHaveLength(puts);
  expect(f.graph.head).toBe(later.generation);
  expect([...f.graph.generations]).toEqual(anchors);
  expect([...f.graph.revisionPins]).toEqual(pins);
  expect(f.graph.commands).toHaveLength(0);
  const retained = new Set<string>();
  expect((await captureObjectRecoveryCoverage(f.graph, store, retained)).anchorCount).toBe('2');
  expect(await protectedObjectDigests(f.graph, store)).toEqual(retained);
  expect(await replayObjectErasure(store, `sha256:${hash(old.bytes)}`, retained, true)).toBe('conflict');
});

test('a current build cannot substitute for an unavailable retained original generation', async () => {
  const objects = new MemoryObjects(), f = fixture(objects);
  const old = await retainedOriginalBuild(f, objects, 'original');
  const puts = objects.puts.length;
  await expect(backfillRetainedModelCustody(f.env, backfillOptions([modelDirectory])))
    .rejects.toBeInstanceOf(RevisionUnavailable);
  expect(objects.puts).toHaveLength(puts);
  expect(objects.data.has(hash(old.bytes))).toBe(false);
  expect(f.graph.revisionPins.get(old.revision)).toBe(old.generation);
  expect(f.graph.commands).toHaveLength(0);
});

test('partial resume restores a lost previously verified shape before publishing its generation root', async () => {
  const objects = new MemoryObjects(), f = fixture(objects);
  const old = await retainedOriginalBuild(f, objects, 'rewind');
  const options = { ...backfillOptions([old.directory]), maxObjects: 1 };
  let checkpoint = await backfillRetainedModelCustody(f.env, options);
  const first = old.profiles[0]!;
  objects.data.delete(first.sha256);
  checkpoint = await backfillRetainedModelCustody(f.env, { ...options, checkpoint });
  expect(checkpoint.pending).toEqual({ generation: old.generation, nextArtifact: 1 });
  expect(objects.data.get(first.sha256)).toEqual(new Uint8Array(first.bytes));
  expect(objects.data.has(hash(old.bytes))).toBe(false);
  expect(checkpoint.complete).toBe(false);
  const complete = await backfillRetainedModelCustody(f.env, { ...backfillOptions([old.directory]), checkpoint });
  expect(complete.complete).toBe(true);
  expect(objects.puts.filter(digest => digest === first.sha256)).toHaveLength(2);
  expect((await readPinnedRevisionModel(f.env, old.revision)).manifest).toEqual(new Uint8Array(old.bytes));
  expect(f.graph.head).toBe(old.generation);
  expect(f.graph.commands).toHaveLength(0);
});

test('completed checkpoint replay still refuses changed original shape bytes', async () => {
  const objects = new MemoryObjects(), f = fixture(objects);
  const old = await retainedOriginalBuild(f, objects, 'completed-replay');
  const options = backfillOptions([old.directory]);
  const checkpoint = await backfillRetainedModelCustody(f.env, options);
  expect(checkpoint.complete).toBe(true);
  writeFileSync(join(old.directory, old.profiles[1]!.file), 'changed original after custody');
  const puts = objects.puts.length;
  await expect(backfillRetainedModelCustody(f.env, { ...options, checkpoint }))
    .rejects.toBeInstanceOf(RevisionCorrupt);
  expect(objects.puts).toHaveLength(puts);
  expect(objects.data.get(hash(old.bytes))).toEqual(new Uint8Array(old.bytes));
  expect(f.graph.commands).toHaveLength(0);
});

for (const missing of [false, true]) {
  test(`${missing ? 'missing' : 'corrupt'} later original shape prevents every artifact upload and root publication`, async () => {
    const objects = new MemoryObjects(), f = fixture(objects);
    const old = await retainedOriginalBuild(f, objects, 'invalid');
    const shape = join(old.directory, old.profiles[1]!.file);
    if (missing) rmSync(shape); else writeFileSync(shape, 'changed original shape');
    const puts = objects.puts.length;
    await expect(backfillRetainedModelCustody(f.env, { ...backfillOptions([old.directory]), maxObjects: 1 }))
      .rejects.toBeInstanceOf(missing ? RevisionUnavailable : RevisionCorrupt);
    expect(objects.puts).toHaveLength(puts);
    expect(objects.data.has(old.profiles[0]!.sha256)).toBe(false);
    expect(objects.data.has(hash(old.bytes))).toBe(false);
    expect(f.graph.commands).toHaveLength(0);
  });
}

test('retained generation state and graph command module must match the exact original build', async () => {
  for (const mismatch of ['command-module', 'state'] as const) {
    const objects = new MemoryObjects(), f = fixture(objects);
    const old = await retainedOriginalBuild(f, objects, 'mismatch');
    const original = f.graph.generations.get(old.generation)!;
    if (mismatch === 'command-module') {
      f.graph.generations.set(old.generation, { ...original, commandModule: '0.4.9' });
    } else {
      const anchor = await prepareWorkComponent(objects, old.generation, {
        modelManifestSha256: '0'.repeat(64), commandModule: old.commandModule, entailment: 'none',
      }, PROFILES.generation);
      f.graph.generations.set(old.generation, { ...original, manifest: `urn:rezics:sha256:${anchor}` });
    }
    const puts = objects.puts.length;
    await expect(backfillRetainedModelCustody(f.env, backfillOptions([old.directory])))
      .rejects.toBeInstanceOf(RevisionCorrupt);
    expect(objects.puts).toHaveLength(puts);
    expect(objects.data.has(hash(old.bytes))).toBe(false);
  }
});

test('backfill rejects corrupt existing objects and verifies newly uploaded bytes before saving progress', async () => {
  for (const existing of [true, false]) {
    const objects = new MemoryObjects(), f = fixture(objects);
    const old = await retainedOriginalBuild(f, objects, 'corruption');
    const digest = old.profiles[0]!.sha256;
    if (existing) objects.data.set(digest, Buffer.from('corrupt existing artifact'));
    else {
      const put = objects.put.bind(objects);
      objects.put = async bytes => {
        const result = await put(bytes);
        if (result === digest) objects.data.set(result, Buffer.from('corrupt read-back artifact'));
        return result;
      };
    }
    const saved: BackfillCheckpoint[] = [];
    await expect(backfillRetainedModelCustody(f.env, backfillOptions([old.directory]),
      value => { saved.push(structuredClone(value)); })).rejects.toBeInstanceOf(RevisionCorrupt);
    expect(saved.every(value => value.objects === 0)).toBe(true);
    expect(objects.data.has(hash(old.bytes))).toBe(false);
    expect(f.graph.commands).toHaveLength(0);
  }
});

test('a lost checkpoint write resumes from prior persisted progress and safely reuses verified objects', async () => {
  const objects = new MemoryObjects(), f = fixture(objects);
  const old = await retainedOriginalBuild(f, objects, 'checkpoint');
  let persisted: BackfillCheckpoint | undefined;
  await expect(backfillRetainedModelCustody(f.env, { ...backfillOptions([old.directory]), maxObjects: 1 }, value => {
    if (value.objects > 0) throw new Error('checkpoint unavailable');
    persisted = structuredClone(value);
  })).rejects.toThrow('checkpoint unavailable');
  expect(persisted?.objects).toBe(0);
  expect(objects.data.has(old.profiles[0]!.sha256)).toBe(true);
  const result = await backfillRetainedModelCustody(f.env, {
    ...backfillOptions([old.directory]), checkpoint: persisted!,
  });
  expect(result).toMatchObject({ complete: true, generations: 1, objects: 3 });
  expect(objects.puts.filter(digest => digest === old.profiles[0]!.sha256)).toHaveLength(1);
  expect(objects.gets.filter(digest => digest === old.profiles[0]!.sha256).length).toBeGreaterThanOrEqual(2);
  expect(f.graph.commands).toHaveLength(0);
});

test('a lost PUT acknowledgement resumes the same generation without duplicate object writes', async () => {
  const objects = new MemoryObjects(), f = fixture(objects);
  const old = await retainedOriginalBuild(f, objects, 'put-response');
  const put = objects.put.bind(objects);
  let loseResponse = true;
  objects.put = async bytes => {
    const digest = await put(bytes);
    if (loseResponse && digest === old.profiles[0]!.sha256) {
      loseResponse = false; throw new ObjectUnavailable('PUT acknowledgement lost');
    }
    return digest;
  };
  let persisted: BackfillCheckpoint | undefined;
  await expect(backfillRetainedModelCustody(f.env, backfillOptions([old.directory]),
    value => { persisted = structuredClone(value); })).rejects.toBeInstanceOf(RevisionUnavailable);
  expect(persisted?.objects).toBe(0);
  expect(objects.data.has(old.profiles[0]!.sha256)).toBe(true);
  expect((await backfillRetainedModelCustody(f.env, {
    ...backfillOptions([old.directory]), checkpoint: persisted!,
  })).complete).toBe(true);
  expect(objects.puts.filter(digest => digest === old.profiles[0]!.sha256)).toHaveLength(1);
  expect(f.graph.commands).toHaveLength(0);
});

test('initial checkpoint failure prevents any artifact publication', async () => {
  const objects = new MemoryObjects(), f = fixture(objects);
  const old = await retainedOriginalBuild(f, objects, 'initial-checkpoint');
  const puts = objects.puts.length;
  await expect(backfillRetainedModelCustody(f.env, backfillOptions([old.directory]),
    () => { throw new Error('initial checkpoint unavailable'); })).rejects.toThrow('initial checkpoint unavailable');
  expect(objects.puts).toHaveLength(puts);
  expect(objects.data.has(hash(old.bytes))).toBe(false);
});

test('backfill defaults to 32 artifacts and refuses turns above the 64 artifact limit', async () => {
  for (const limit of [undefined, 64]) {
    const objects = new MemoryObjects(), f = fixture(objects);
    const old = await retainedOriginalBuild(f, objects, 'bounded', '0.4.1', 65);
    const result = await backfillRetainedModelCustody(f.env, {
      ...backfillOptions([old.directory]), ...(limit === undefined ? {} : { maxObjects: limit }),
    });
    expect(result.objects).toBe(limit ?? 32);
    expect(result.complete).toBe(false);
    expect(result.pending?.nextArtifact).toBe(limit ?? 32);
    expect(objects.data.has(hash(old.bytes))).toBe(false);
    const puts = objects.puts.length;
    for (const maxObjects of [0, 65]) {
      await expect(backfillRetainedModelCustody(f.env, { ...backfillOptions([old.directory]), maxObjects }))
        .rejects.toBeInstanceOf(ModelCustodyBackfillConflict);
    }
    expect(objects.puts).toHaveLength(puts);
  }
});

test('the original total backfill deadline remains bounded across resumed turns', async () => {
  const objects = new MemoryObjects(), f = fixture(objects);
  const old = await retainedOriginalBuild(f, objects, 'deadline');
  let now = 1000;
  const options = { ...backfillOptions([old.directory]), now: () => now, maxObjects: 1 };
  let checkpoint = await backfillRetainedModelCustody(f.env, { ...options, deadlineAt: 1100 });
  expect(checkpoint.deadlineAt).toBe(1100);
  now = 1099;
  checkpoint = await backfillRetainedModelCustody(f.env, { ...options, checkpoint });
  expect(checkpoint.deadlineAt).toBe(1100);
  expect(checkpoint.objects).toBe(2);
  await expect(backfillRetainedModelCustody(f.env, { ...options, checkpoint, deadlineAt: 1101 }))
    .rejects.toBeInstanceOf(ModelCustodyBackfillConflict);
  const puts = objects.puts.length;
  now = 1100;
  await expect(backfillRetainedModelCustody(f.env, { ...options, checkpoint }))
    .rejects.toBeInstanceOf(ModelCustodyBackfillDeadline);
  expect(objects.puts).toHaveLength(puts);
  await expect(backfillRetainedModelCustody(f.env, { ...options, deadlineAt: now + 600_001 }))
    .rejects.toBeInstanceOf(ModelCustodyBackfillConflict);
});

test('resume refuses another retained head, checkpoint context or source identity', async () => {
  const objects = new MemoryObjects(), f = fixture(objects);
  const old = await retainedOriginalBuild(f, objects, 'context');
  const options = { ...backfillOptions([old.directory]), maxObjects: 1 };
  const checkpoint = await backfillRetainedModelCustody(f.env, options);
  const puts = objects.puts.length;
  f.graph.head = `urn:rezics:model-generation:${'f'.repeat(64)}`;
  await expect(backfillRetainedModelCustody(f.env, { ...options, checkpoint }))
    .rejects.toBeInstanceOf(ModelCustodyBackfillConflict);
  f.graph.head = checkpoint.head;
  await expect(backfillRetainedModelCustody(f.env, { ...options, checkpoint: { ...checkpoint, context: 'another-context' } }))
    .rejects.toBeInstanceOf(ModelCustodyBackfillConflict);
  await expect(backfillRetainedModelCustody(f.env, { ...options, checkpoint, sourceKey: 'another-source' }))
    .rejects.toBeInstanceOf(ModelCustodyBackfillConflict);
  expect(objects.puts).toHaveLength(puts);
  expect(f.graph.head).toBe(old.generation);
  expect(f.graph.revisionPins.get(old.revision)).toBe(old.generation);
  expect(f.graph.commands).toHaveLength(0);
});

test('model custody operator arguments name multiple original build roots and a resumable local checkpoint', () => {
  const old = resolve('.temp/retained-model-original'), later = resolve('.temp/retained-model-later');
  const checkpoint = resolve('.temp/model-custody-checkpoint.json');
  expect(modelCustodyArguments(['--custody', '--build', old, '--build', later,
    '--checkpoint', checkpoint, '--max-objects', '3'])).toEqual({
    buildDirectories: [old, later], checkpoint, maxObjects: 3,
  });
  for (const args of [[], ['--custody'], ['--custody', '--build'],
    ['--custody', '--build', old, '--max-objects', '0'],
    ['--custody', '--build', old, '--max-objects', '1.5'],
    ['--custody', '--build', old, '--checkpoint', checkpoint, '--checkpoint', checkpoint],
    ['--custody', '--build', old, '--max-objects', '3', '--max-objects', '4'],
    ['--custody', '--build', 'https://models.example/original'],
    ['--custody', '--build', 'postgres://user:secret@127.0.0.1/database'],
    ['--custody', '--build', old, '--checkpoint', 's3://access:secret@bucket/checkpoint'],
    ['--custody', '--build', old, '--secret', 'credential']]) {
    expect(() => modelCustodyArguments(args)).toThrow();
  }
});
