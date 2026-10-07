import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const digest = generationDigest(generation);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?commandModule WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(generation)} a rv:ModelGeneration, rv:RevisionAnchor ;
      rv:component ${iri(MODEL_COMPONENT)} ; rv:manifest ?manifest ; rv:commandModuleVersion ?commandModule }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) throw new RevisionNotFound('model generation is not retained');
  const row = rows[0]!;
  if (rows.length !== 1 || !row.manifest || !row.commandModule) {
    throw new RevisionCorrupt('model generation anchor is incomplete or ambiguous');
  }
  const state = await readWorkComponentState(env, row.manifest.value, generation, PROFILES.generation);
  if (state.modelManifestSha256 !== digest || state.commandModule !== row.commandModule.value || state.entailment !== 'none') {
    throw new RevisionCorrupt('model generation state differs from its anchor');
  }
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
