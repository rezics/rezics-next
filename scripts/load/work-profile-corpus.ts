import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { runBoundedIndices } from './schedule.ts';
import {
  compatibleLoadStorage,
  loadCompatibility,
  type LoadCompatibility,
} from './compatibility.ts';

const root = resolve(import.meta.dir, '../..');

export const WORK_PROFILE_SCALES = ['small', 'medium', 'large'] as const;
export type WorkProfileScale = (typeof WORK_PROFILE_SCALES)[number];
export const WORK_PROFILE_DIMENSIONS = [
  'unrelatedWorks',
  'unrelatedPosts',
  'follows',
  'memberships',
  'historyDepth',
  'realmSize',
  'conceptVocabulary',
] as const;
export type WorkProfileDimension = (typeof WORK_PROFILE_DIMENSIONS)[number];
export type CorpusDimensions = Record<WorkProfileDimension, number>;
/** Diagnostic sizes, not a qualified capacity claim. Stop at the 600-second setup ceiling. */
const sizes: Record<WorkProfileDimension, readonly [number, number, number]> = {
  unrelatedWorks: [4, 16, 64],
  unrelatedPosts: [4, 16, 64],
  follows: [4, 16, 64],
  memberships: [2, 8, 24],
  historyDepth: [2, 8, 32],
  realmSize: [4, 16, 64],
  conceptVocabulary: [8, 32, 128],
};
export function workProfileDimensions(
  dimension: WorkProfileDimension,
  scale: WorkProfileScale,
  fixed: CorpusDimensions,
): CorpusDimensions {
  if (
    !WORK_PROFILE_DIMENSIONS.includes(dimension) ||
    !WORK_PROFILE_SCALES.includes(scale) ||
    WORK_PROFILE_DIMENSIONS.some((key) => !Number.isSafeInteger(fixed[key]) || fixed[key] < 0)
  )
    throw new Error('Invalid work profile corpus dimensions');
  return { ...fixed, [dimension]: sizes[dimension][WORK_PROFILE_SCALES.indexOf(scale)]! };
}

export interface CorpusCommand {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A product command route, never a raw SPARQL/SQL or internal import endpoint. */
  path: `/v1/${string}`;
  body: unknown;
  headers?: HeadersInit;
}
export interface CorpusApi {
  command<T>(key: string, command: CorpusCommand, signal?: AbortSignal): Promise<T>;
  read<T>(path: `/v1/${string}`, signal?: AbortSignal): Promise<T>;
}

/** Scenario owners supply tokens and command preconditions, using their existing public flows. */
export function workProfileCorpusApi(
  origin: string,
  bearer: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): CorpusApi {
  const target = new URL(origin);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw new Error('Invalid corpus API origin');
  const signalFor = (signal?: AbortSignal) =>
    signal && options.signal
      ? AbortSignal.any([signal, options.signal])
      : (signal ?? options.signal);
  return {
    async command<T>(key: string, command: CorpusCommand, signal?: AbortSignal): Promise<T> {
      if (
        !/^[A-Za-z0-9:_./-]{1,128}$/.test(key) ||
        !command.path.startsWith('/v1/') ||
        !/^[A-Za-z0-9._~/-]+$/.test(command.path) ||
        /[?#]|(?:^|\/)\.\.(?:\/|$)/.test(command.path)
      )
        throw new Error('Invalid corpus command');
      const headers = new Headers(command.headers);
      headers.set('authorization', `Bearer ${bearer}`);
      headers.set('idempotency-key', key);
      headers.set('content-type', 'application/json');
      const response = await (options.fetch ?? fetch)(new URL(command.path, target), {
        method: command.method,
        headers,
        body: JSON.stringify(command.body),
        signal: signalFor(signal),
        redirect: 'error',
      });
      // Pending and partial commands are not a completed corpus.
      if (![200, 201, 204].includes(response.status))
        throw new Error(`Corpus command ${key} returned HTTP ${response.status}`);
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    },
    async read<T>(path: `/v1/${string}`, signal?: AbortSignal): Promise<T> {
      const url = new URL(path, target);
      if (
        !path.startsWith('/v1/') ||
        !url.pathname.startsWith('/v1/') ||
        url.origin !== target.origin
      )
        throw new Error('Invalid corpus read');
      const response = await (options.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${bearer}` },
        signal: signalFor(signal),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Corpus verification returned HTTP ${response.status}`);
      return (await response.json()) as T;
    },
  };
}

export interface WorkProfileCorpusRecipe {
  /** Bump when command recipes or verification semantics change, not for code-only edits. */
  version: string;
  fixed: CorpusDimensions;
  /** Set up the fixed dataset through the public API, returning scenario handles. */
  initialize(api: CorpusApi, key: string): Promise<void>;
  /** One independent entity, relationship or revision. History must run serially. */
  grow(api: CorpusApi, dimension: WorkProfileDimension, index: number, key: string): Promise<void>;
  /** Read back the actual dimensions through public APIs; validate result correctness too. */
  verify(api: CorpusApi): Promise<CorpusDimensions>;
}
export interface CorpusBackupDriver {
  /** Quiesce writers and retain all owner stores as one stopped backup; never a live volume copy. */
  backup(id: string, signal: AbortSignal): Promise<string>;
  /** Restore an isolated writable copy and wait for migrations, readiness and smoke checks. */
  restore(backup: string, target: string, signal: AbortSignal): Promise<void>;
}
export interface WorkProfileCorpusManifest {
  format: 'work-profile-corpus-v1';
  id: string;
  recipe: string;
  dimension: WorkProfileDimension;
  scale: WorkProfileScale;
  dimensions: CorpusDimensions;
  backup: string;
  preparationMs: number;
  compatibility: LoadCompatibility;
}
export function workProfileCorpusId(
  recipe: WorkProfileCorpusRecipe,
  dimension: WorkProfileDimension,
  scale: WorkProfileScale,
): string {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(recipe.version))
    throw new Error('Invalid corpus recipe version');
  const dimensions = workProfileDimensions(dimension, scale, recipe.fixed);
  const canonical = WORK_PROFILE_DIMENSIONS.map((key) => [key, dimensions[key]]);
  const digest = createHash('sha256')
    .update(JSON.stringify([recipe.version, dimension, canonical]))
    .digest('hex');
  return `work-profile-${digest.slice(0, 16)}`;
}
function checkDimensions(actual: CorpusDimensions, expected: CorpusDimensions): void {
  for (const key of WORK_PROFILE_DIMENSIONS)
    if (actual[key] !== expected[key])
      throw new Error(`Corpus dimension ${key}: ${actual[key]} != ${expected[key]}`);
}

/** Build one dimension once, then let each measurement restore its own copy.
 * Recipe methods receive only the public client; no storage seeding is done here. */
export async function prepareWorkProfileCorpus(input: {
  recipe: WorkProfileCorpusRecipe;
  api: CorpusApi;
  backups: CorpusBackupDriver;
  dimension: WorkProfileDimension;
  scale: WorkProfileScale;
  directory: string;
  startedAt?: number;
}): Promise<WorkProfileCorpusManifest> {
  const { recipe, dimension, scale } = input;
  const compatibility = loadCompatibility(root);
  const dimensions = workProfileDimensions(dimension, scale, recipe.fixed);
  if (dimensions[dimension] < recipe.fixed[dimension])
    throw new Error('Fixed dimension exceeds the smallest requested scale');
  const id = workProfileCorpusId(recipe, dimension, scale);
  const directory = resolve(input.directory);
  if (
    relative(root, directory).startsWith('..') &&
    directory !== '/tmp' &&
    !directory.startsWith('/tmp/')
  )
    throw new Error('Corpus manifests must stay in this checkout or /tmp');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.json`);
  const retained = (): WorkProfileCorpusManifest | undefined => {
    if (!existsSync(path)) return undefined;
    const saved = JSON.parse(readFileSync(path, 'utf8')) as WorkProfileCorpusManifest;
    if (
      saved.format !== 'work-profile-corpus-v1' ||
      saved.id !== id ||
      saved.recipe !== recipe.version ||
      saved.dimension !== dimension ||
      saved.scale !== scale ||
      !saved.backup ||
      !Number.isFinite(saved.preparationMs) ||
      saved.preparationMs < 0 ||
      saved.preparationMs > 600_000 ||
      !compatibleLoadStorage(saved.compatibility, compatibility)
    )
      throw new Error('Incompatible or incomplete work profile corpus backup');
    checkDimensions(saved.dimensions, dimensions);
    return saved;
  };
  const saved = retained();
  if (saved) return saved;
  const lock = `${path}.lock`;
  try {
    mkdirSync(lock);
  } catch {
    throw new Error('Corpus preparation is already claimed; use its completed backup or retry');
  }
  try {
    // Another process may have finished between the first lookup and lock acquisition.
    const completed = retained();
    if (completed) return completed;
    const started = input.startedAt ?? performance.now();
    const remaining = () => 600_000 - (performance.now() - started);
    if (remaining() <= 0) throw new Error('Corpus preparation exceeded 600 seconds');
    const signal = AbortSignal.timeout(Math.ceil(remaining()));
    const checkBudget = () => {
      signal.throwIfAborted();
      // A synchronous driver can delay AbortSignal's timer while wall time still advances.
      if (remaining() <= 0) throw new Error('Corpus preparation exceeded 600 seconds');
    };
    const api: CorpusApi = {
      command: (key, command) => input.api.command(key, command, signal),
      read: (path) => input.api.read(path, signal),
    };
    await recipe.initialize(api, `${id}:base`);
    checkBudget();
    const count = dimensions[dimension] - recipe.fixed[dimension];
    await runBoundedIndices(
      count,
      dimension === 'historyDepth' ? 1 : 2,
      async (index) => {
        checkBudget();
        await recipe.grow(api, dimension, index, `${id}:${dimension}:${index}`);
      },
      () => {},
    );
    checkDimensions(await recipe.verify(api), dimensions);
    checkBudget();
    const backup = await input.backups.backup(id, signal);
    checkBudget();
    if (!backup) throw new Error('Corpus backup driver returned no stopped backup');
    const manifest: WorkProfileCorpusManifest = {
      format: 'work-profile-corpus-v1',
      id,
      recipe: recipe.version,
      dimension,
      scale,
      dimensions,
      backup,
      compatibility,
      preparationMs: performance.now() - started,
    };
    const temporary = `${path}.pending`;
    writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n');
    renameSync(temporary, path);
    return manifest;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export async function restoreWorkProfileCorpus(
  manifest: WorkProfileCorpusManifest,
  target: string,
  backups: CorpusBackupDriver,
  startedAt = performance.now(),
): Promise<number> {
  if (
    !/^[a-z][a-z0-9-]{1,60}$/.test(target) ||
    target === manifest.id ||
    target === manifest.backup
  )
    throw new Error('Corpus measurement needs a distinct isolated restore target');
  if (!compatibleLoadStorage(manifest.compatibility, loadCompatibility(root)))
    throw new Error('Corpus storage/model compatibility changed');
  const remaining = 600_000 - (performance.now() - startedAt);
  if (remaining <= 0) throw new Error('Corpus restore preparation exceeded 600 seconds');
  const signal = AbortSignal.timeout(Math.ceil(remaining));
  await backups.restore(manifest.backup, target, signal);
  signal.throwIfAborted();
  if (performance.now() - startedAt > 600_000)
    throw new Error('Corpus restore preparation exceeded 600 seconds');
  return performance.now() - startedAt;
}
