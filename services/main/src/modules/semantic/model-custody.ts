import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { COMMAND_MODULE_VERSION } from '../../infrastructure/profile.ts';
import { GRAPHS, RV, hash, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { readWorkComponentState, RevisionCorrupt, RevisionNotFound, RevisionUnavailable } from '../work/history.ts';
import { MODEL_COMPONENT, PROFILES } from './schema.ts';

interface ModelProfileArtifact { id: string; sha256: string; file: string }
interface ModelManifest { commandModule: string; profiles: ModelProfileArtifact[] }

export interface ExactModelGeneration {
  generation: string;
  manifestSha256: string;
  manifest: Uint8Array;
  commandModule: string;
  shapes: { profile: string; sha256: string; bytes: Uint8Array }[];
}

export const MODEL_CUSTODY_BACKFILL_COST = {
  builds: 64, profiles: 512, artifactBytes: 4 * 1_048_576, buildBytes: 32 * 1_048_576,
  turnObjects: 32, maximumTurnObjects: 64, totalMs: 600_000,
} as const;
export class ModelCustodyBackfillDeadline extends Error {}
export class ModelCustodyBackfillConflict extends Error {}
export interface ModelCustodyBackfillCheckpoint {
  format: 'rezics-model-custody-backfill-v1'; context: string; deadlineAt: number; head: string;
  after: string | null; pending: { generation: string; nextArtifact: number } | null;
  generations: number; objects: number; complete: boolean;
}

function generationDigest(generation: string): string {
  if (!/^urn:rezics:model-generation:[0-9a-f]{64}$/.test(generation)) {
    throw new RevisionCorrupt('model generation is not an exact digest');
  }
  return generation.slice(-64);
}

function checkedManifest(bytes: Uint8Array): ModelManifest {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new RevisionCorrupt('model manifest is not JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RevisionCorrupt('model manifest is not an object');
  }
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.commandModule !== 'string' || !manifest.commandModule
    || !Array.isArray(manifest.profiles) || !manifest.profiles.length) {
    throw new RevisionCorrupt('model manifest lacks its command module and profiles');
  }
  const ids = new Set<string>();
  for (const value of manifest.profiles) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RevisionCorrupt('model profile artifact is invalid');
    }
    const profile = value as Record<string, unknown>;
    if (typeof profile.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id)
      || ids.has(profile.id) || typeof profile.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(profile.sha256)
      || profile.file !== `shapes/${profile.id}.ttl`) {
      throw new RevisionCorrupt('model profile artifact identity is invalid or duplicated');
    }
    ids.add(profile.id);
  }
  return manifest as unknown as ModelManifest;
}

/** Filesystem fixtures use the same digest keys and durable create/read-back contract. */
class DirectoryModelObjects implements ImmutableObjects {
  constructor(private readonly directory: string) {}

  async put(bytes: Uint8Array): Promise<string> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const digest = hash(bytes);
    const staging = join(this.directory, `.stage-model-${Bun.randomUUIDv7()}`);
    try {
      const fd = openSync(staging, 'wx', 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(staging, join(this.directory, digest)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { unlinkSync(staging); }
    const directoryFd = openSync(this.directory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    await this.get(digest);
    return digest;
  }

  async get(digest: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new ObjectIntegrityError('invalid model object digest');
    let bytes: Uint8Array;
    try { bytes = readFileSync(join(this.directory, digest)); }
    catch { throw new ObjectUnavailable('committed model artifact is unavailable'); }
    if (hash(bytes) !== digest) throw new ObjectIntegrityError('model artifact digest differs');
    return bytes;
  }
}

function modelObjects(env: WorkActivationEnvironment): ImmutableObjects {
  return env.workObjects ?? new DirectoryModelObjects(env.objectDirectory);
}

async function exactObject(objects: ImmutableObjects, digest: string): Promise<Uint8Array> {
  try {
    const bytes = await objects.get(digest);
    if (hash(bytes) !== digest) throw new RevisionCorrupt('model artifact digest differs');
    return bytes;
  } catch (error) {
    if (error instanceof ObjectUnavailable) throw new RevisionUnavailable(error.message);
    if (error instanceof ObjectIntegrityError) throw new RevisionCorrupt(error.message);
    throw error;
  }
}

async function retainedModelState(env: WorkActivationEnvironment, generation: string,
  anchor?: { manifest: string; commandModule: string }): Promise<{ manifestSha256: string; commandModule: string }> {
  const digest = generationDigest(generation);
  if (!anchor) {
    const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?commandModule WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(generation)} a rv:ModelGeneration, rv:RevisionAnchor ;
        rv:component ${iri(MODEL_COMPONENT)} ; rv:manifest ?manifest ; rv:commandModuleVersion ?commandModule }
    } LIMIT 2`, 4096);
    const rows = result.results?.bindings ?? [];
    if (!rows.length) throw new RevisionNotFound('model generation is not retained');
    const row = rows[0]!;
    if (rows.length !== 1 || !row.manifest || !row.commandModule) {
      throw new RevisionCorrupt('model generation anchor is incomplete or ambiguous');
    }
    anchor = { manifest: row.manifest.value, commandModule: row.commandModule.value };
  }
  const state = await readWorkComponentState(env, anchor.manifest, generation, PROFILES.generation);
  if (state.modelManifestSha256 !== digest || state.commandModule !== anchor.commandModule || state.entailment !== 'none') {
    throw new RevisionCorrupt('model generation state differs from its anchor');
  }
  return { manifestSha256: digest, commandModule: anchor.commandModule };
}

function originalArtifact(path: string): Uint8Array {
  try {
    const size = statSync(path).size;
    if (size > MODEL_CUSTODY_BACKFILL_COST.artifactBytes) throw new RevisionCorrupt('original model artifact exceeds its byte bound');
    const bytes = readFileSync(path);
    if (bytes.length > MODEL_CUSTODY_BACKFILL_COST.artifactBytes) throw new RevisionCorrupt('original model artifact exceeds its byte bound');
    return bytes;
  } catch (error) {
    if (error instanceof RevisionCorrupt) throw error;
    throw new RevisionUnavailable(`original model artifact is unavailable: ${path}`);
  }
}

/** One bounded custody turn. Only original bytes reach object storage; model
 * heads, revision pins, receipts and graph sequence are read-only throughout. */
export async function backfillRetainedModelCustody(env: WorkActivationEnvironment, options: {
  buildDirectories: string[]; checkpoint?: ModelCustodyBackfillCheckpoint; maxObjects?: number;
  deadlineAt?: number; now?: () => number; sourceKey?: string;
}, saveCheckpoint?: (checkpoint: ModelCustodyBackfillCheckpoint) => void | Promise<void>): Promise<ModelCustodyBackfillCheckpoint> {
  const now = options.now ?? Date.now;
  const started = now();
  const maxObjects = options.maxObjects ?? MODEL_CUSTODY_BACKFILL_COST.turnObjects;
  if (!Number.isInteger(maxObjects) || maxObjects < 1 || maxObjects > MODEL_CUSTODY_BACKFILL_COST.maximumTurnObjects
    || !options.buildDirectories.length || options.buildDirectories.length > MODEL_CUSTODY_BACKFILL_COST.builds) {
    throw new ModelCustodyBackfillConflict('invalid bounded model custody turn');
  }
  const context = hash(JSON.stringify([env.lineage, resolve(env.objectDirectory), options.sourceKey ?? '']));
  const previous = options.checkpoint;
  const deadlineAt = previous?.deadlineAt ?? options.deadlineAt ?? started + MODEL_CUSTODY_BACKFILL_COST.totalMs;
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt > started + MODEL_CUSTODY_BACKFILL_COST.totalMs
    || previous && options.deadlineAt !== undefined && options.deadlineAt !== previous.deadlineAt) {
    throw new ModelCustodyBackfillConflict('model custody deadline cannot be extended on resume');
  }
  let expired = false;
  const checkDeadline = () => {
    if (expired || now() >= deadlineAt) throw new ModelCustodyBackfillDeadline('model custody preparation exceeded its total deadline');
  };
  checkDeadline();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<ModelCustodyBackfillCheckpoint> => {
    const headResult = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ?head }
    } LIMIT 2`, 4096);
    checkDeadline();
    const heads = headResult.results?.bindings ?? [];
    if (heads.length !== 1 || !heads[0]?.head) throw new RevisionCorrupt('retained model head is unavailable or ambiguous');
    const head = heads[0].head.value;
    generationDigest(head);
    if (previous && (previous.format !== 'rezics-model-custody-backfill-v1' || previous.context !== context
      || previous.head !== head || !Number.isSafeInteger(previous.generations) || previous.generations < 0
      || !Number.isSafeInteger(previous.objects) || previous.objects < 0 || typeof previous.complete !== 'boolean'
      || previous.pending && (!Number.isInteger(previous.pending.nextArtifact) || previous.pending.nextArtifact < 0))) {
      throw new ModelCustodyBackfillConflict('model custody checkpoint belongs to another source or model head');
    }
    if (previous?.after) generationDigest(previous.after);
    if (previous?.pending) generationDigest(previous.pending.generation);
    await retainedModelState(env, head);
    checkDeadline();
    let checkpoint: ModelCustodyBackfillCheckpoint = previous ? { ...previous } : {
      format: 'rezics-model-custody-backfill-v1', context, deadlineAt, head, after: null, pending: null,
      generations: 0, objects: 0, complete: false,
    };
    // A completed invocation is replayed as a bounded verification pass. A
    // stale local completion marker cannot mask subsequently lost originals.
    if (checkpoint.complete) checkpoint = { ...checkpoint, after: null, pending: null,
      generations: 0, objects: 0, complete: false };
    const save = async () => { checkDeadline(); await saveCheckpoint?.(checkpoint); checkDeadline(); };
    await save();
    // Build paths are supplied explicitly even for the current generation.
    // Hash-indexing these files is local input matching, not an artifact registry.
    const builds = new Map<string, { bytes: Uint8Array; manifest: ModelManifest; directory: string }>();
    for (const directory of new Set(options.buildDirectories.map(path => resolve(path)))) {
      checkDeadline();
      const bytes = originalArtifact(join(directory, 'manifest.json'));
      const manifest = checkedManifest(bytes);
      if (manifest.profiles.length > MODEL_CUSTODY_BACKFILL_COST.profiles) throw new RevisionCorrupt('original model profile count exceeds its bound');
      const digest = hash(bytes);
      if (builds.has(digest)) throw new ModelCustodyBackfillConflict('multiple original build paths name the same model generation');
      builds.set(digest, { bytes, manifest, directory });
    }
    const objects = modelObjects(env);
    let completedThisTurn = 0;
    while (!checkpoint.complete) {
      checkDeadline();
      const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?generation ?manifest ?commandModule WHERE {
        GRAPH ${iri(GRAPHS.revisions)} { ?generation a rv:ModelGeneration .
          OPTIONAL { ?generation a rv:RevisionAnchor ; rv:component ${iri(MODEL_COMPONENT)} ;
            rv:manifest ?manifest ; rv:commandModuleVersion ?commandModule } }
        ${checkpoint.after ? `FILTER(STR(?generation) > ${JSON.stringify(checkpoint.after)})` : ''}
      } ORDER BY STR(?generation) LIMIT 2`, 8192)).results?.bindings;
      checkDeadline();
      if (!rows) throw new RevisionUnavailable('retained model inventory is unavailable');
      if (!rows.length) {
        if (checkpoint.pending) throw new ModelCustodyBackfillConflict('pending retained model generation disappeared');
        checkpoint = { ...checkpoint, complete: true };
        await save();
        break;
      }
      const row = rows[0]!;
      if (!row.generation || !row.manifest || !row.commandModule
        || rows[1]?.generation?.value === row.generation.value) throw new RevisionCorrupt('retained model anchor is incomplete or ambiguous');
      const generation = row.generation.value;
      const state = await retainedModelState(env, generation, { manifest: row.manifest.value, commandModule: row.commandModule.value });
      checkDeadline();
      if (checkpoint.pending && checkpoint.pending.generation !== generation) throw new ModelCustodyBackfillConflict('retained model inventory changed during custody');
      const build = builds.get(state.manifestSha256);
      if (!build) throw new RevisionUnavailable(`original retained build is required for ${generation}`);
      if (build.manifest.commandModule !== state.commandModule) throw new RevisionCorrupt('original model module differs from its retained anchor');
      let inputBytes = build.bytes.length;
      const artifacts = build.manifest.profiles.map(profile => {
        checkDeadline();
        const bytes = originalArtifact(join(build.directory, profile.file));
        inputBytes += bytes.length;
        if (inputBytes > MODEL_CUSTODY_BACKFILL_COST.buildBytes) throw new RevisionCorrupt('original model build exceeds its byte bound');
        if (hash(bytes) !== profile.sha256) throw new RevisionCorrupt('original model shape differs from its manifest');
        return { digest: profile.sha256, bytes };
      });
      artifacts.push({ digest: state.manifestSha256, bytes: build.bytes });
      let index = checkpoint.pending?.nextArtifact ?? 0;
      if (index >= artifacts.length) throw new ModelCustodyBackfillConflict('model custody artifact cursor exceeds the original build');
      // A restored or interrupted object owner may have lost a previously
      // acknowledged shape. Rewind to its exact original instead of trusting
      // the local progress file as custody evidence.
      for (let prior = 0; prior < index; prior++) {
        try { await exactObject(objects, artifacts[prior]!.digest); }
        catch (error) {
          if (!(error instanceof RevisionUnavailable)) throw error;
          index = prior;
          break;
        }
        checkDeadline();
      }
      checkpoint = { ...checkpoint, pending: { generation, nextArtifact: index } };
      await save();
      while (index < artifacts.length && completedThisTurn < maxObjects) {
        checkDeadline();
        const artifact = artifacts[index]!;
        if (index === artifacts.length - 1) {
          // A resumed cursor cannot publish a root without rechecking its full
          // object closure, including shapes uploaded in a prior process.
          for (const shape of artifacts.slice(0, -1)) { await exactObject(objects, shape.digest); checkDeadline(); }
        }
        try { await exactObject(objects, artifact.digest); }
        catch (error) {
          if (!(error instanceof RevisionUnavailable)) throw error;
          checkDeadline();
          try {
            if (await objects.put(artifact.bytes) !== artifact.digest) throw new RevisionCorrupt('custodied original model digest differs');
          } catch (error) {
            if (error instanceof ObjectUnavailable) throw new RevisionUnavailable(error.message);
            if (error instanceof ObjectIntegrityError) throw new RevisionCorrupt(error.message);
            throw error;
          }
          await exactObject(objects, artifact.digest);
        }
        checkDeadline();
        index++; completedThisTurn++;
        checkpoint = { ...checkpoint, objects: checkpoint.objects + 1, pending: { generation, nextArtifact: index } };
        if (index === artifacts.length) {
          checkpoint = { ...checkpoint, after: generation, pending: null, generations: checkpoint.generations + 1 };
        }
        await save();
      }
      if (completedThisTurn === maxObjects) break;
    }
    const lastHead = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ?head }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
    checkDeadline();
    if (lastHead.length !== 1 || lastHead[0]?.head?.value !== head) throw new ModelCustodyBackfillConflict('model head changed during original artifact custody');
    return checkpoint;
  };
  try {
    return await Promise.race([run(), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { expired = true;
        reject(new ModelCustodyBackfillDeadline('model custody preparation exceeded its total deadline')); },
        Math.max(1, deadlineAt - started));
    })]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}

/** Publish the digest-rooted manifest only after every referenced shape is custodied. */
export async function custodyModelGenerationArtifacts(env: WorkActivationEnvironment, generation: string,
  manifestBytes: Uint8Array, readShape: (file: string) => Uint8Array): Promise<void> {
  const digest = generationDigest(generation);
  if (hash(manifestBytes) !== digest) throw new RevisionCorrupt('model manifest differs from its generation');
  const manifest = checkedManifest(manifestBytes);
  const objects = modelObjects(env);
  for (const profile of manifest.profiles) {
    const bytes = readShape(profile.file);
    if (hash(bytes) !== profile.sha256) throw new RevisionCorrupt('model shape differs from its manifest');
    if (await objects.put(bytes) !== profile.sha256) throw new RevisionCorrupt('custodied model shape digest differs');
  }
  if (await objects.put(manifestBytes) !== digest) throw new RevisionCorrupt('custodied model manifest digest differs');
}

const buildCustody = new WeakMap<object, Map<string, Promise<void>>>();

/** Remember successful immutable custody per storage instance; failures remain retryable. */
export async function custodyGeneratedModelGeneration(env: WorkActivationEnvironment, generation: string,
  manifestBytes: Uint8Array, modelDirectory: string): Promise<void> {
  if (hash(manifestBytes) !== generationDigest(generation)) throw new RevisionCorrupt('model manifest differs from its generation');
  if (checkedManifest(manifestBytes).commandModule !== COMMAND_MODULE_VERSION) {
    throw new RevisionCorrupt('generated model command module differs from the active build');
  }
  const storage = env.workObjects ?? env;
  let generations = buildCustody.get(storage);
  if (!generations) { generations = new Map(); buildCustody.set(storage, generations); }
  let pending = generations.get(generation);
  if (!pending) {
    pending = custodyModelGenerationArtifacts(env, generation, manifestBytes,
      file => readFileSync(join(modelDirectory, file)));
    generations.set(generation, pending);
  }
  try { await pending; }
  catch (error) {
    if (generations.get(generation) === pending) generations.delete(generation);
    throw error;
  }
}

/** Shared retention traversal visits verified artifacts without retaining all shape bytes. */
export async function visitModelGenerationArtifacts(generation: string,
  readObject: (digest: string) => Promise<Uint8Array>,
  visit: (digest: string, bytes: Uint8Array, profile: string | null) => void,
): Promise<{ manifestSha256: string; commandModule: string }> {
  const digest = generationDigest(generation);
  const bytes = await readObject(digest);
  if (hash(bytes) !== digest) throw new RevisionCorrupt('model manifest digest differs');
  const manifest = checkedManifest(bytes);
  visit(digest, bytes, null);
  for (const profile of manifest.profiles) {
    const shape = await readObject(profile.sha256);
    if (hash(shape) !== profile.sha256) throw new RevisionCorrupt('model shape digest differs');
    visit(profile.sha256, shape, profile.id);
  }
  return { manifestSha256: digest, commandModule: manifest.commandModule };
}

/** Read a retained generation through its own anchor; neither head nor build artifacts substitute. */
export async function readExactModelGeneration(env: WorkActivationEnvironment, generation: string): Promise<ExactModelGeneration> {
  const state = await retainedModelState(env, generation);
  const digest = state.manifestSha256;
  const objects = modelObjects(env);
  let manifestBytes: Uint8Array | undefined;
  const shapes: ExactModelGeneration['shapes'] = [];
  const model = await visitModelGenerationArtifacts(generation, key => exactObject(objects, key),
    (key, bytes, profile) => {
      if (profile === null) manifestBytes = bytes;
      else shapes.push({ profile, sha256: key, bytes });
    });
  if (model.commandModule !== state.commandModule) throw new RevisionCorrupt('model manifest command module differs');
  return { generation, manifestSha256: digest, manifest: manifestBytes!, commandModule: model.commandModule, shapes };
}

/** A revision's model pin survives later activation and is never resolved from the current head. */
export async function readPinnedRevisionModel(env: WorkActivationEnvironment, revision: string): Promise<ExactModelGeneration> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?generation WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ; rv:modelGeneration ?generation }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) throw new RevisionNotFound('revision has no retained model generation');
  if (rows.length !== 1 || !rows[0]?.generation) throw new RevisionCorrupt('revision model pin is ambiguous');
  return readExactModelGeneration(env, rows[0].generation.value);
}
