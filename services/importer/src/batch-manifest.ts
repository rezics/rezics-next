import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { SourceId } from '@rezics/conversion';
import { admitDumpCompression, parseDumpCompression, type DumpCompression } from './compressed-dump.ts';
import { DumpInputError } from './dump-input.ts';
import { createSourceRegistration } from './source-registry.ts';

export const BATCH_MANIFEST_VERSION = 1;
export const MAX_BATCH_JOBS = 16;
export const MAX_BATCH_MANIFEST_BYTES = 64 * 1024;
export const MAX_BATCH_PATH_BYTES = 4096;
export const MAX_BATCH_NAME_BYTES = 64;
export const SOURCE_KIND = /^(?:bangumi|vndb|openlibrary|wikidata)$/;
export const SOURCE_ALIAS = /^[a-z][a-z0-9_-]{0,31}$/u;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const JOB_KEYS = new Set([
  'source',
  'sourceAlias',
  'dump',
  'state',
  'compression',
  'decodeBudget',
  'disappearanceThreshold',
  'name',
]);
const MANIFEST_KEYS = new Set(['version', 'jobs']);
const FORBIDDEN_JOB_KEYS: Readonly<Record<string, string>> = {
  dumpSet:
    'An Open Library dump-set manifest is one job\'s complete --dump input, not a batch job list. The ordinary single-source CLI has not delivered a dump-set flag.',
  include: 'Batch manifests cannot include other files.',
  glob: 'Batch jobs require an exact local path; globs are not expanded.',
  command: 'Batch jobs cannot declare shell commands or executable hooks.',
  hook: 'Batch jobs cannot declare executable hooks.',
  url: 'Batch jobs cannot use network input URLs.',
  stdin: 'Batch jobs cannot share stdin or use dump "-".',
  env: 'Batch jobs cannot interpolate environment values.',
  credentials: 'Credentials stay on the batch invocation; they cannot be embedded in the manifest.',
  accountKey: 'Credentials stay on the batch invocation; they cannot be embedded in the manifest.',
  account: 'Credentials stay on the batch invocation; they cannot be embedded in the manifest.',
  api: 'Credentials stay on the batch invocation; they cannot be embedded in the manifest.',
  auth: 'Credentials stay on the batch invocation; they cannot be embedded in the manifest.',
  client: 'Credentials stay on the batch invocation; they cannot be embedded in the manifest.',
};

export type BatchInputMode = 'file' | 'gzip-file' | 'vndb-archive';

export type BatchFileIdentity = Readonly<{
  path: string;
  declared: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}>;

export type BatchJobPlan = Readonly<{
  index: number;
  name: string;
  sourceKind: SourceId;
  sourceAlias: string;
  dump: BatchFileIdentity;
  state: BatchFileIdentity;
  compression: DumpCompression;
  decodeBudget?: number;
  disappearanceThreshold?: number;
  inputMode: BatchInputMode;
}>;

export type BatchManifestPlan = Readonly<{
  version: typeof BATCH_MANIFEST_VERSION;
  manifest: BatchFileIdentity;
  directory: string;
  jobs: readonly BatchJobPlan[];
  note: string;
}>;

export class BatchManifestError extends DumpInputError {
  readonly code = 2;
  constructor(message: string) {
    super(message, 'invalid-input');
    this.name = 'BatchManifestError';
  }
}

export const BATCH_PREFLIGHT_NOTE =
  'Successful preflight is local shape and path validation. It does not prove dump integrity, current authority, or that every job will succeed. Existing single-source sealing, input integrity and disappearance handling still govern each job.';

function boundedString(value: unknown, role: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
    throw new BatchManifestError(`${role} must be a non-empty bounded string.`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes)
    throw new BatchManifestError(`${role} exceeds the supported ${maxBytes}-byte bound.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    throw new BatchManifestError(`${role} contains control characters.`);
  return value;
}

function objectKeys(value: object): string[] {
  return Object.keys(value);
}

function refuseUnknownKeys(value: object, allowed: ReadonlySet<string>, role: string): void {
  for (const key of objectKeys(value)) {
    if (allowed.has(key)) continue;
    const forbidden = FORBIDDEN_JOB_KEYS[key];
    if (forbidden) throw new BatchManifestError(forbidden);
    throw new BatchManifestError(`${role} has unsupported field ${JSON.stringify(key)}.`);
  }
}

function refusePathForm(declared: string, role: string): void {
  if (declared === '-' || declared === '/dev/stdin' || declared === '/dev/fd/0')
    throw new BatchManifestError(`${role} cannot be stdin; each job needs its own complete local file.`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(declared) && !isAbsolute(declared))
    throw new BatchManifestError(`${role} cannot be a URL or networked input.`);
  if (/\$[A-Za-z_{]|`|\$\{/.test(declared))
    throw new BatchManifestError(`${role} cannot interpolate environment or shell values.`);
}

export function resolveAgainstManifest(declared: string, manifestDirectory: string, role: string): string {
  const path = boundedString(declared, role, MAX_BATCH_PATH_BYTES);
  refusePathForm(path, role);
  return resolve(manifestDirectory, path);
}

export function sameFileIdentity(
  left: Pick<BatchFileIdentity, 'dev' | 'ino'>,
  right: Pick<BatchFileIdentity, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function identityChanged(expected: BatchFileIdentity, actual: BatchFileIdentity): boolean {
  return (
    !sameFileIdentity(expected, actual) || expected.size !== actual.size || expected.mtimeMs !== actual.mtimeMs
  );
}

async function admitRegularFile(path: string, role: string, declared: string): Promise<BatchFileIdentity> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, OPEN_FLAGS);
    const identity = await handle.stat();
    if (!identity.isFile()) throw new BatchManifestError(`${role} is not a regular file: ${JSON.stringify(path)}.`);
    return {
      path,
      declared,
      dev: identity.dev,
      ino: identity.ino,
      size: identity.size,
      mtimeMs: identity.mtimeMs,
    };
  } catch (error) {
    if (error instanceof BatchManifestError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new BatchManifestError(`${role} does not exist: ${JSON.stringify(path)}.`);
    if (code === 'ELOOP') throw new BatchManifestError(`${role} must not be a symbolic link.`);
    if (code === 'ENXIO' || code === 'EAGAIN' || code === 'ENOTSUP')
      throw new BatchManifestError(`${role} is a special file and cannot be used as importer ${role.toLowerCase()}.`);
    throw new BatchManifestError(`${role} could not be opened as a regular file.`);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Identity is already captured or the open failed.
      }
    }
  }
}

export async function admitBatchPath(
  declared: string,
  manifestDirectory: string,
  role: string,
): Promise<BatchFileIdentity> {
  const path = resolveAgainstManifest(declared, manifestDirectory, role);
  return admitRegularFile(path, role, declared);
}

function parseSourceKind(value: unknown, index: number): SourceId {
  const source = boundedString(value, `Job ${index} source`, 32);
  if (!SOURCE_KIND.test(source))
    throw new BatchManifestError(
      `Job ${index} source must be one of bangumi, vndb, openlibrary or wikidata; no source is auto-detected.`,
    );
  return source as SourceId;
}

function parseAlias(value: unknown, index: number, sourceKind: SourceId): string {
  if (value === undefined) return sourceKind;
  const alias = boundedString(value, `Job ${index} sourceAlias`, 32);
  if (!SOURCE_ALIAS.test(alias))
    throw new BatchManifestError(`Job ${index} sourceAlias must be an exact configured source identifier.`);
  return alias;
}

function parseCompression(value: unknown, index: number, sourceKind: SourceId): DumpCompression {
  if (value === undefined) return 'none';
  const compression = boundedString(value, `Job ${index} compression`, 16);
  try {
    const parsed = parseDumpCompression(compression);
    admitDumpCompression(sourceKind, parsed);
    return parsed;
  } catch (error) {
    throw new BatchManifestError(
      error instanceof DumpInputError ? error.message : `Job ${index} compression is not a delivered single-source option.`,
    );
  }
}

function parseDecodeBudget(value: unknown, index: number, compression: DumpCompression): number | undefined {
  if (value === undefined) return undefined;
  if (compression !== 'gzip')
    throw new BatchManifestError(`Job ${index} decodeBudget is only admitted with compression gzip.`);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new BatchManifestError(`Job ${index} decodeBudget must be a positive safe integer byte count.`);
  return value;
}

function parseThreshold(value: unknown, index: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new BatchManifestError(`Job ${index} disappearanceThreshold must be a number from 0 through 1.`);
  const text = value === 0 || value === 1 ? String(value) : String(value);
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(text))
    throw new BatchManifestError(`Job ${index} disappearanceThreshold must match the ordinary CLI number form.`);
  return value;
}

function parseName(value: unknown, index: number, fallback: string): string {
  if (value === undefined) return fallback;
  return boundedString(value, `Job ${index} name`, MAX_BATCH_NAME_BYTES);
}

function inputMode(sourceKind: SourceId, compression: DumpCompression): BatchInputMode {
  if (sourceKind === 'vndb') return 'vndb-archive';
  if (compression === 'gzip') return 'gzip-file';
  return 'file';
}

function parseJob(raw: unknown, index: number, manifestDirectory: string): Promise<BatchJobPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BatchManifestError(`Job ${index} must be an object.`);
  refuseUnknownKeys(raw, JOB_KEYS, `Job ${index}`);
  const record = raw as Record<string, unknown>;
  const sourceKind = parseSourceKind(record.source, index);
  const sourceAlias = parseAlias(record.sourceAlias, index, sourceKind);
  try {
    createSourceRegistration(sourceKind, { source: sourceAlias });
  } catch {
    throw new BatchManifestError(`Job ${index} configured source ${JSON.stringify(sourceAlias)} is not a valid alias.`);
  }
  const compression = parseCompression(record.compression, index, sourceKind);
  if (sourceKind === 'vndb' && compression !== 'none')
    throw new BatchManifestError(`Job ${index} VNDB archives reject gzip before credentials or state are opened.`);
  const decodeBudget = parseDecodeBudget(record.decodeBudget, index, compression);
  const disappearanceThreshold = parseThreshold(record.disappearanceThreshold, index);
  const name = parseName(record.name, index, `${sourceAlias}`);
  if (typeof record.dump !== 'string' || typeof record.state !== 'string')
    throw new BatchManifestError(`Job ${index} must declare dump and state as local complete file paths.`);
  return Promise.all([
    admitBatchPath(record.dump, manifestDirectory, `Job ${index} dump`),
    admitBatchPath(record.state, manifestDirectory, `Job ${index} state`),
  ]).then(([dump, state]) => {
    if (sameFileIdentity(dump, state))
      throw new BatchManifestError(`Job ${index} dump and state cannot be the same file.`);
    return {
      index,
      name,
      sourceKind,
      sourceAlias,
      dump,
      state,
      compression,
      ...(decodeBudget === undefined ? {} : { decodeBudget }),
      ...(disappearanceThreshold === undefined ? {} : { disappearanceThreshold }),
      inputMode: inputMode(sourceKind, compression),
    };
  });
}

function refuseConflicts(jobs: readonly BatchJobPlan[]): void {
  const aliases = new Map<string, number>();
  const ownership = new Map<string, number>();
  for (const job of jobs) {
    const priorAlias = aliases.get(job.sourceAlias);
    if (priorAlias !== undefined)
      throw new BatchManifestError(
        `Jobs ${priorAlias} and ${job.index} both declare configured source ${JSON.stringify(job.sourceAlias)}; they are not merged.`,
      );
    aliases.set(job.sourceAlias, job.index);
    const ownerKey = `${job.sourceAlias}@${job.state.dev}:${job.state.ino}`;
    const priorOwner = ownership.get(ownerKey);
    if (priorOwner !== undefined)
      throw new BatchManifestError(
        `Jobs ${priorOwner} and ${job.index} share source ${JSON.stringify(job.sourceAlias)} on the same state file.`,
      );
    ownership.set(ownerKey, job.index);
  }
  for (let left = 0; left < jobs.length; left++) {
    for (let right = left + 1; right < jobs.length; right++) {
      const a = jobs[left]!;
      const b = jobs[right]!;
      if (a.state.declared !== b.state.declared && sameFileIdentity(a.state, b.state) && a.sourceAlias === b.sourceAlias)
        throw new BatchManifestError(
          `Jobs ${a.index} and ${b.index} name different state paths that are the same file for ${JSON.stringify(a.sourceAlias)}.`,
        );
    }
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BatchManifestError('Batch manifest is not exact JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BatchManifestError('Batch manifest must be a JSON object.');
  return value as Record<string, unknown>;
}

export async function readBatchManifestFile(path: string): Promise<{ identity: BatchFileIdentity; text: string }> {
  const resolved = resolve(path);
  refusePathForm(path, 'Batch manifest');
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, OPEN_FLAGS);
    const identity = await handle.stat();
    if (!identity.isFile()) throw new BatchManifestError('Batch manifest is not a regular file.');
    if (identity.size > MAX_BATCH_MANIFEST_BYTES)
      throw new BatchManifestError(`Batch manifest exceeds the ${MAX_BATCH_MANIFEST_BYTES}-byte bound.`);
    if (identity.size <= 0) throw new BatchManifestError('Batch manifest is empty.');
    const bytes = new Uint8Array(identity.size);
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    const after = await handle.stat();
    if (read.bytesRead !== identity.size || after.size !== identity.size || after.mtimeMs !== identity.mtimeMs)
      throw new BatchManifestError('Batch manifest changed while it was being read.');
    return {
      identity: {
        path: resolved,
        declared: path,
        dev: identity.dev,
        ino: identity.ino,
        size: identity.size,
        mtimeMs: identity.mtimeMs,
      },
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch (error) {
    if (error instanceof BatchManifestError) throw error;
    if (error instanceof TypeError) throw new BatchManifestError('Batch manifest is not UTF-8 JSON.');
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new BatchManifestError(`Batch manifest does not exist: ${JSON.stringify(resolved)}.`);
    if (code === 'ELOOP') throw new BatchManifestError('Batch manifest must not be a symbolic link.');
    throw new BatchManifestError('Batch manifest could not be opened as a regular file.');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The bounded read already finished or failed.
      }
    }
  }
}

export async function preflightBatchManifest(manifestPath: string): Promise<BatchManifestPlan> {
  const file = await readBatchManifestFile(manifestPath);
  const document = parseJsonObject(file.text);
  refuseUnknownKeys(document, MANIFEST_KEYS, 'Batch manifest');
  if (document.version !== BATCH_MANIFEST_VERSION)
    throw new BatchManifestError(`Batch manifest version must be ${BATCH_MANIFEST_VERSION}.`);
  if (!Array.isArray(document.jobs)) throw new BatchManifestError('Batch manifest jobs must be an array.');
  if (document.jobs.length < 1) throw new BatchManifestError('Batch manifest must declare at least one job.');
  if (document.jobs.length > MAX_BATCH_JOBS)
    throw new BatchManifestError(`Batch manifest admits at most ${MAX_BATCH_JOBS} jobs.`);
  const directory = dirname(file.identity.path);
  const jobs: BatchJobPlan[] = [];
  for (let offset = 0; offset < document.jobs.length; offset++) {
    jobs.push(await parseJob(document.jobs[offset], offset + 1, directory));
  }
  refuseConflicts(jobs);
  return {
    version: BATCH_MANIFEST_VERSION,
    manifest: file.identity,
    directory,
    jobs,
    note: BATCH_PREFLIGHT_NOTE,
  };
}

export async function revalidateJobInputs(job: BatchJobPlan, directory: string): Promise<void> {
  const dump = await admitBatchPath(job.dump.declared, directory, `Job ${job.index} dump`);
  const state = await admitBatchPath(job.state.declared, directory, `Job ${job.index} state`);
  if (identityChanged(job.dump, dump))
    throw new BatchManifestError(
      `Job ${job.index} dump changed between local preview and execution; the replacement was not followed.`,
    );
  if (!sameFileIdentity(job.state, state))
    throw new BatchManifestError(
      `Job ${job.index} state was replaced between local preview and execution; the replacement was not followed.`,
    );
}

export function formatDisappearanceThreshold(value: number): string {
  if (value === 0) return '0';
  if (value === 1) return '1';
  return String(value);
}

export function ordinaryImportArgv(
  job: BatchJobPlan,
  credentials: {
    api: string;
    accountKey: string;
    account: string;
    client: string;
    auth: string;
  },
  progressMode?: 'human' | 'jsonl',
): string[] {
  const argv = [
    '--source',
    job.sourceKind,
    '--dump',
    job.dump.path,
    '--state',
    job.state.path,
    '--api',
    credentials.api,
    '--account-key',
    credentials.accountKey,
    '--account',
    credentials.account,
    '--client',
    credentials.client,
    '--auth',
    credentials.auth,
  ];
  if (job.sourceAlias !== job.sourceKind) argv.push('--source-alias', job.sourceAlias);
  if (job.compression !== 'none') argv.push('--compression', job.compression);
  if (job.decodeBudget !== undefined) argv.push('--decode-budget', String(job.decodeBudget));
  if (job.disappearanceThreshold !== undefined)
    argv.push('--disappearance-threshold', formatDisappearanceThreshold(job.disappearanceThreshold));
  if (progressMode) argv.push('--progress', progressMode);
  return argv;
}

export function ordinaryRecoveryCommand(job: BatchJobPlan): string[] {
  const alias = job.sourceAlias === job.sourceKind ? '' : ` --source-alias ${JSON.stringify(job.sourceAlias)}`;
  const compression = job.compression === 'none' ? '' : ` --compression ${job.compression}`;
  const budget = job.decodeBudget === undefined ? '' : ` --decode-budget ${job.decodeBudget}`;
  const threshold =
    job.disappearanceThreshold === undefined
      ? ''
      : ` --disappearance-threshold ${formatDisappearanceThreshold(job.disappearanceThreshold)}`;
  return [
    'This batch report authorizes nothing and cannot resume a request. Per-source journals remain the recovery authority.',
    `Resume the blocked source with the ordinary importer, not by skipping jobs from this report:`,
    `  bun services/importer/src/cli.ts --source ${job.sourceKind}${alias} --dump ${JSON.stringify(job.dump.path)} --state ${JSON.stringify(job.state.path)}${compression}${budget}${threshold} --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>`,
  ];
}

export function observationRecoveryCommand(job: BatchJobPlan): string[] {
  return [
    ...ordinaryRecoveryCommand(job),
    `Inspect and resolve the source observation without executing it from this report:`,
    `  bun services/importer/src/cli.ts observations --state ${JSON.stringify(job.state.path)} --source ${JSON.stringify(job.sourceAlias)}`,
  ];
}
