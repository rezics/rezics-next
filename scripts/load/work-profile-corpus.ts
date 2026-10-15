import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fixtureRoot } from '../fixture/stack.ts';
import { runBoundedIndices } from './schedule.ts';
import {
  compatibleLoadStorage,
  loadCompatibility,
  type LoadCompatibility,
} from './compatibility.ts';

const root = resolve(import.meta.dir, '../..');

export const WORK_PROFILE_SCALES = ['small', 'medium', 'large'] as const;
export type WorkProfileScale = (typeof WORK_PROFILE_SCALES)[number];
const baseDimensions = [
  'unrelatedWorks',
  'unrelatedPosts',
  'follows',
  'memberships',
  'historyDepth',
  'realmSize',
  'conceptVocabulary',
] as const;
const populationDimensions = [
  'recipeOccurrences', 'zoneNavigationEntries', 'mountedCollectionResources', 'readerShelfEntries',
] as const;
export const WORK_PROFILE_DIMENSIONS = [...baseDimensions, ...populationDimensions] as const;
export type WorkProfileDimension = (typeof WORK_PROFILE_DIMENSIONS)[number];
// Existing scenario recipes can omit axes they do not populate. The owner
// normalizes those axes to zero; new axes remain a typed, explicit contract.
export type CorpusDimensions = Record<(typeof baseDimensions)[number], number>
  & Partial<Record<(typeof populationDimensions)[number], number>>;
/** Diagnostic sizes, not a qualified capacity claim. Stop at the 600-second setup ceiling. */
const sizes: Record<WorkProfileDimension, readonly [number, number, number]> = {
  unrelatedWorks: [4, 16, 64],
  unrelatedPosts: [4, 16, 64],
  follows: [4, 16, 64],
  memberships: [4, 16, 64],
  historyDepth: [2, 8, 32],
  realmSize: [4, 16, 64],
  conceptVocabulary: [4, 16, 64],
  recipeOccurrences: [100, 400, 1600],
  zoneNavigationEntries: [4, 16, 64],
  mountedCollectionResources: [4, 16, 64],
  readerShelfEntries: [4, 16, 64],
};
export const WORK_PROFILE_POPULATION_UNITS = {
  recipeOccurrences: { unit: 'active recipe section, ingredient line or step', expected: 'constant per page' },
  zoneNavigationEntries: { unit: 'public mount with a route segment and Work or Collection target',
    expected: 'keyed route lookup logarithmic; presentation enumeration linear up to 50 entries' },
  mountedCollectionResources: { unit: 'public Work in the mounted Collection',
    expected: 'linear up to the 24-item page cap, then bounded' },
  readerShelfEntries: { unit: "distinct Work with a reading status row on the reader shelf",
    expected: 'O(log N + P), with bounded page size P' },
} as const;
export function workProfileDimensions(
  dimension: WorkProfileDimension,
  scale: WorkProfileScale,
  fixed: CorpusDimensions,
): Required<CorpusDimensions> {
  if (
    !WORK_PROFILE_DIMENSIONS.includes(dimension) ||
    !WORK_PROFILE_SCALES.includes(scale) ||
    baseDimensions.some(key => fixed[key] === undefined) ||
    WORK_PROFILE_DIMENSIONS.some((key) => !Number.isSafeInteger(fixed[key] ?? 0) || (fixed[key] ?? 0) < 0)
  )
    throw new Error('Invalid work profile corpus dimensions');
  return { ...Object.fromEntries(WORK_PROFILE_DIMENSIONS.map(key => [key, fixed[key] ?? 0])),
    [dimension]: sizes[dimension][WORK_PROFILE_SCALES.indexOf(scale)]! } as Required<CorpusDimensions>;
}

export interface CorpusCommand {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A product command route, never a raw SPARQL/SQL or internal import endpoint. */
  path: `/v1/${string}`;
  body: unknown;
  headers?: HeadersInit;
  stage?: WorkProfileScale;
}
export const CORPUS_REFUSAL_BYTES = 300;
function refusalExcerpt(bytes: Uint8Array): string {
  // Do not turn a truncated UTF-8 character into a larger replacement sequence.
  return new TextDecoder().decode(bytes.subarray(0, CORPUS_REFUSAL_BYTES), { stream: true });
}
async function readRefusalBody(response: Response): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
    if (!reader) return '';
    const bytes = new Uint8Array(CORPUS_REFUSAL_BYTES);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const part = chunk.value.subarray(0, bytes.length - length);
      bytes.set(part, length);
      length += part.length;
    }
    return refusalExcerpt(bytes.subarray(0, length));
  } catch {
    return 'body unreadable';
  } finally {
    // Stop an oversized or broken upstream body; cancellation cannot hide its HTTP status.
    try { await reader?.cancel(); } catch { /* Preserve the typed refusal. */ }
    try { reader?.releaseLock(); } catch { /* Preserve the typed refusal. */ }
  }
}
export class CorpusCommandError extends Error {
  readonly body: string;
  readonly code?: string;
  readonly responseStatus?: string | number;
  constructor(readonly key: string, readonly operation: string, readonly stage: WorkProfileScale | undefined,
    readonly status: number, detail: string) {
    const body = refusalExcerpt(Buffer.from(detail));
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { /* Non-JSON or truncated errors still carry their body. */ }
    const typed = parsed !== null && typeof parsed === 'object' ? parsed as { code?: unknown; status?: unknown } : {};
    const code = typeof typed.code === 'string' ? typed.code : undefined;
    const responseStatus = typeof typed.status === 'string' || typeof typed.status === 'number' ? typed.status : undefined;
    super(`Corpus command ${key} (${operation}, stage ${stage ?? 'unspecified'}) returned HTTP ${status}`
      + ` code=${code ?? 'unspecified'} status=${responseStatus ?? 'unspecified'}: ${body}`);
    this.name = 'CorpusCommandError';
    this.body = body;
    this.code = code;
    this.responseStatus = responseStatus;
  }
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
      const requestSignal = signalFor(signal);
      requestSignal?.throwIfAborted();
      const response = await (options.fetch ?? fetch)(new URL(command.path, target), {
        method: command.method,
        headers,
        body: JSON.stringify(command.body),
        signal: requestSignal,
        redirect: 'error',
      });
      // Pending and partial commands are not a completed corpus.
      if (![200, 201, 204].includes(response.status)) {
        const detail = await readRefusalBody(response);
        throw new CorpusCommandError(key, `${command.method} ${command.path}`, command.stage, response.status, detail);
      }
      // An in-process API can return an empty cancelled success instead of rejecting fetch.
      requestSignal?.throwIfAborted();
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
      const requestSignal = signalFor(signal);
      requestSignal?.throwIfAborted();
      const response = await (options.fetch ?? fetch)(url, {
        headers: { authorization: `Bearer ${bearer}` },
        signal: requestSignal,
        redirect: 'error',
      });
      requestSignal?.throwIfAborted();
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Corpus verification returned HTTP ${response.status}: ${detail}`);
      }
      return (await response.json()) as T;
    },
  };
}

export interface WorkProfileCorpusRecipe {
  /** Bump when command recipes or verification semantics change, not for code-only edits. */
  version: string;
  fixed: CorpusDimensions;
  /** Co-grown populations in the same stopped cut; the primary axis is always first. */
  populations?: readonly WorkProfileDimension[];
  /** Set up the fixed dataset through the public API, returning scenario handles. */
  initialize(api: CorpusApi, key: string): Promise<void>;
  /** One independent entity, relationship or revision. History must run serially. */
  grow(api: CorpusApi, dimension: WorkProfileDimension, index: number, key: string): Promise<void>;
  /** Read back the actual dimensions through public APIs; validate result correctness too. */
  verify(api: CorpusApi): Promise<CorpusDimensions>;
}
function checkpointDimensions(recipe: Pick<WorkProfileCorpusRecipe, 'version' | 'fixed' | 'populations'>, dimension: WorkProfileDimension,
  scale: WorkProfileScale): CorpusDimensions {
  return (recipe.populations ?? []).reduce((fixed, axis) => workProfileDimensions(axis, scale, fixed),
    workProfileDimensions(dimension, scale, recipe.fixed));
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
  recipe: Pick<WorkProfileCorpusRecipe, 'version' | 'fixed' | 'populations'>,
  dimension: WorkProfileDimension,
  scale: WorkProfileScale,
  compatibility = loadCompatibility(root),
): string {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(recipe.version))
    throw new Error('Invalid corpus recipe version');
  const dimensions = checkpointDimensions(recipe, dimension, scale);
  const canonical = WORK_PROFILE_DIMENSIONS.map((key) => [key, dimensions[key]]);
  const digest = createHash('sha256')
    // A retained corpus is a schema/model cut, not just a recipe and size.
    // New owner migrations must select a new backup before any restore writes.
    .update(JSON.stringify([recipe.version, dimension, canonical, compatibility.digest]))
    .digest('hex');
  return `work-profile-${digest.slice(0, 16)}`;
}
function checkDimensions(actual: CorpusDimensions, expected: CorpusDimensions): void {
  for (const key of WORK_PROFILE_DIMENSIONS)
    if ((actual[key] ?? 0) !== (expected[key] ?? 0))
      throw new Error(`Corpus dimension ${key}: ${actual[key]} != ${expected[key]}`);
}

/** Retained manifests use the same configured fixture authority as their backups. */
export function corpusManifestDirectory(path: string, checkout = root, fixtures = fixtureRoot): string {
  const directory = resolve(path);
  const within = (base: string) => {
    const child = relative(base, directory);
    return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  };
  if ([checkout, '/tmp', resolve(fixtures, '../work-profiles')].some(within)) return directory;
  throw new Error('Corpus manifests must stay in this checkout, /tmp or the declared shared work-profiles');
}

/** Build one dimension through public APIs and retain each scale's stopped cut.
 * Stable entity identities belong to the retained backup: restoring it preserves
 * ids; a fresh API build generates new ids. The corpus id identifies the recipe
 * and storage cut, not deterministic entity ids across fresh builds.
 * Scales share command keys. Recipes reuse completed live-source handles or
 * replay idempotent commands instead of creating another population. Each stage
 * supplies its own start time and retains one cut of every declared population. */
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
  const dimensions = checkpointDimensions(recipe, dimension, scale);
  if ((dimensions[dimension] ?? 0) < (recipe.fixed[dimension] ?? 0))
    throw new Error('Fixed dimension exceeds the smallest requested scale');
  const id = workProfileCorpusId(recipe, dimension, scale, compatibility);
  // Manifest ids vary by scale; command keys stay stable as the live corpus grows.
  const buildId = workProfileCorpusId(recipe, dimension, 'small', compatibility);
  const directory = corpusManifestDirectory(input.directory);
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
  // All scale checkpoints for this recipe/dimension share one live API build.
  const lock = join(directory, `${buildId}.lock`);
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
      command: (key, command) => input.api.command(key, { ...command, stage: scale }, signal),
      read: (path) => input.api.read(path, signal),
    };
    await recipe.initialize(api, `${buildId}:base`);
    checkBudget();
    for (const axis of new Set([dimension, ...(recipe.populations ?? [])])) {
      const count = (dimensions[axis] ?? 0) - (recipe.fixed[axis] ?? 0);
      if (count < 0) throw new Error('Fixed dimension exceeds the requested scale');
      await runBoundedIndices(
      count,
      axis === 'historyDepth' || axis === 'recipeOccurrences' ? 1 : 2,
      async (index) => {
        checkBudget();
        await recipe.grow(api, axis, index, `${buildId}:${axis}:${index}`);
      },
      () => {},
    );
    }
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
