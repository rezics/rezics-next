import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { Pool } from 'pg';
import { artifactNames } from '../../../scripts/ops/recovery-set.ts';
import { startPostgresCluster } from '../support/postgres-cluster.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const ownKeys = (value: Record<string, unknown>, expected: readonly string[], label: string) => {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} fields are not allowlisted`);
  }
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be plain data`);
  }
  return value as Record<string, unknown>;
}

function safeRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must be a relative path inside the recovery root`);
  }
  return value;
}

function containedPath(root: string, value: unknown, label: string): string {
  const path = safeRelativePath(value, label);
  const resolved = resolve(root, path);
  const back = relative(root, resolved);
  if (
    back === '' ||
    back === '..' ||
    back.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(back)
  ) {
    throw new Error(`${label} escapes the recovery root`);
  }
  return resolved;
}

function realContainedPath(root: string, path: string, label: string): string {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`);
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const back = relative(realRoot, realPath);
  if (
    back === '' ||
    back === '..' ||
    back.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(back)
  ) {
    throw new Error(`${label} resolves outside the recovery root`);
  }
  return realPath;
}

function requireFile(root: string, value: unknown, label: string): string {
  const path = containedPath(root, value, label);
  const realPath = realContainedPath(root, path, label);
  if (!lstatSync(realPath).isFile()) throw new Error(`${label} must be a regular file`);
  return realPath;
}

function requireDirectory(root: string, value: unknown, label: string): string {
  const path = containedPath(root, value, label);
  const realPath = realContainedPath(root, path, label);
  if (!lstatSync(realPath).isDirectory()) throw new Error(`${label} must be a directory`);
  return realPath;
}

function countRegularFilesWithoutLinks(directory: string, label: string): number {
  let files = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic links`);
    if (stats.isDirectory()) files += countRegularFilesWithoutLinks(path, label);
    else if (stats.isFile()) files += 1;
    else throw new Error(`${label} can contain only regular files and directories`);
  }
  return files;
}

export type CurrentRelayTransfer = Readonly<{
  format: 'rezics-current-relay-transfer-v1';
  relayDump: string;
}>;

export type IndependentRestoreExpectations = Readonly<{
  format: 'rezics-independent-restore-expectations-v1';
  samples: readonly Readonly<{ name: string; id: string }>[];
  values: readonly Readonly<{ name: string; value: string }>[];
  originalReceiptTuples: readonly (readonly [string, string, string])[];
}>;

export type IndependentRestoreTransfer = Readonly<{
  format: 'rezics-independent-restore-inputs-v1';
  root: string;
  inputs: Readonly<{
    recoverySet: string;
    currentFrontier: string;
    currentRelayDump: string;
    recipientPrivateKeyCustody: string;
    recoveryHmacKey: string;
    retainedNativeSigningMaterial: string;
  }>;
  expectations: string;
}>;

export type ResolvedIndependentRestoreInputs = Readonly<{
  root: string;
  recoverySet: string;
  currentFrontier: string;
  currentRelayDump: string;
  recipientPrivateKeyCustody: string;
  recoveryHmacKey: string;
  retainedNativeSigningMaterial: string;
  expectations: string;
}>;

export type ImportedCurrentRelay = Readonly<{
  relayPool: Pool;
  identity: Readonly<{
    host: '127.0.0.1';
    port: number;
    user: string;
    database: 'relay';
    clusterDirectory: string;
  }>;
  close: () => Promise<void>;
}>;

function parseExpectations(value: unknown): IndependentRestoreExpectations {
  const data = record(value, 'Expectations');
  ownKeys(data, ['format', 'samples', 'values', 'originalReceiptTuples'], 'Expectations');
  if (data.format !== 'rezics-independent-restore-expectations-v1') {
    throw new Error('Expectations format is invalid');
  }
  const samples = data.samples;
  const values = data.values;
  const receipts = data.originalReceiptTuples;
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > 64) {
    throw new Error('Expectations samples are invalid');
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > 128) {
    throw new Error('Expectations values are invalid');
  }
  if (!Array.isArray(receipts) || receipts.length === 0 || receipts.length > 256) {
    throw new Error('Expectations receipt tuples are invalid');
  }
  const validateNamedString = (entry: unknown, label: string, key: 'id' | 'value') => {
    const item = record(entry, label);
    ownKeys(item, ['name', key], label);
    if (
      typeof item.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.name) ||
      /authority|connection[-_]?string|database[-_]?url|environment|password|secret|token|source[-_]?config/i.test(
        item.name,
      ) ||
      typeof item[key] !== 'string' ||
      item[key].length === 0 ||
      item[key].length > (key === 'id' ? 256 : 4096)
    ) {
      throw new Error(`${label} must contain bounded named strings`);
    }
  };
  for (const sample of samples) validateNamedString(sample, 'Expectation sample', 'id');
  for (const item of values) validateNamedString(item, 'Expectation value', 'value');
  for (const tuple of receipts) {
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      tuple.some((field) => typeof field !== 'string' || field.length === 0 || field.length > 512)
    ) {
      throw new Error('Expectation receipt tuples must contain three bounded strings');
    }
  }
  return value as IndependentRestoreExpectations;
}

/** Build a relative, JSON-safe handle to a retained relay dump under `.temp`. */
export function currentRelayTransferForDump(dumpFile: string): CurrentRelayTransfer {
  const full = resolve(dumpFile);
  const relativePath = relative(repositoryRoot, full).split(process.platform === 'win32' ? '\\' : '/').join('/');
  if (
    relativePath === '' ||
    relativePath.startsWith('../') ||
    isAbsolute(relativePath) ||
    !relativePath.startsWith('.temp/') ||
    !relativePath.endsWith('/relay.dump')
  ) {
    throw new Error('Current relay dump must be retained as `.temp/**/relay.dump`');
  }
  return { format: 'rezics-current-relay-transfer-v1', relayDump: relativePath };
}

export function assertCurrentRelayTransfer(value: unknown): CurrentRelayTransfer {
  const transfer = record(value, 'Current relay transfer');
  ownKeys(transfer, ['format', 'relayDump'], 'Current relay transfer');
  if (transfer.format !== 'rezics-current-relay-transfer-v1') {
    throw new Error('Current relay transfer format is invalid');
  }
  const relayDump = safeRelativePath(transfer.relayDump, 'Current relay dump');
  if (!relayDump.startsWith('.temp/') || !relayDump.endsWith('/relay.dump')) {
    throw new Error('Current relay dump must be retained as `.temp/**/relay.dump`');
  }
  return { format: 'rezics-current-relay-transfer-v1', relayDump };
}

/** Parse the data-only bundle that a fresh restore child may receive. */
export function assertIndependentRestoreTransfer(value: unknown): IndependentRestoreTransfer {
  const transfer = record(value, 'Independent restore transfer');
  ownKeys(transfer, ['format', 'root', 'inputs', 'expectations'], 'Independent restore transfer');
  if (transfer.format !== 'rezics-independent-restore-inputs-v1') {
    throw new Error('Independent restore transfer format is invalid');
  }
  const root = safeRelativePath(transfer.root, 'Recovery root');
  if (!root.startsWith('.temp/')) throw new Error('Recovery root must be inside `.temp`');
  const inputs = record(transfer.inputs, 'Independent restore inputs');
  ownKeys(
    inputs,
    [
      'recoverySet',
      'currentFrontier',
      'currentRelayDump',
      'recipientPrivateKeyCustody',
      'recoveryHmacKey',
      'retainedNativeSigningMaterial',
    ],
    'Independent restore inputs',
  );
  for (const [name, path] of Object.entries(inputs)) safeRelativePath(path, `Input ${name}`);
  const expectations = safeRelativePath(transfer.expectations, 'Expectations');
  return {
    format: 'rezics-independent-restore-inputs-v1',
    root,
    inputs: inputs as IndependentRestoreTransfer['inputs'],
    expectations,
  };
}

export function serializeIndependentRestoreTransfer(value: unknown): string {
  return JSON.stringify(assertIndependentRestoreTransfer(value));
}

/** Resolve only the explicitly transferred inputs and reject links or missing files. */
export function resolveIndependentRestoreInputs(value: unknown): ResolvedIndependentRestoreInputs {
  const transfer = assertIndependentRestoreTransfer(value);
  const rootCandidate = resolve(repositoryRoot, transfer.root);
  const worktreeRelative = relative(repositoryRoot, rootCandidate);
  if (
    worktreeRelative === '' ||
    worktreeRelative === '..' ||
    worktreeRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(worktreeRelative)
  ) {
    throw new Error('Recovery root escapes the worktree');
  }
  const tempRoot = realpathSync(join(repositoryRoot, '.temp'));
  const root = realContainedPath(tempRoot, rootCandidate, 'Recovery root');
  const recoverySet = requireDirectory(root, transfer.inputs.recoverySet, 'Recovery set');
  const recoveryFiles = [...artifactNames, 'set.json'].sort();
  const actualRecoveryFiles = readdirSync(recoverySet).sort();
  if (
    actualRecoveryFiles.length !== recoveryFiles.length ||
    actualRecoveryFiles.some((name, index) => name !== recoveryFiles[index])
  ) {
    throw new Error('Recovery set does not contain the exact allowlisted artifacts');
  }
  for (const name of recoveryFiles) requireFile(recoverySet, name, `Recovery artifact ${name}`);
  const currentFrontier = requireFile(root, transfer.inputs.currentFrontier, 'Current frontier');
  const currentRelayDump = requireFile(root, transfer.inputs.currentRelayDump, 'Current relay dump');
  const recipientPrivateKeyCustody = requireDirectory(
    root,
    transfer.inputs.recipientPrivateKeyCustody,
    'Recipient private key custody',
  );
  if (countRegularFilesWithoutLinks(recipientPrivateKeyCustody, 'Recipient private key custody') === 0) {
    throw new Error('Recipient private key custody has no regular files');
  }
  const recoveryHmacKey = requireFile(root, transfer.inputs.recoveryHmacKey, 'Recovery HMAC key');
  if (lstatSync(recoveryHmacKey).size === 0) throw new Error('Recovery HMAC key is empty');
  const retainedNativeSigningMaterial = requireFile(
    root,
    transfer.inputs.retainedNativeSigningMaterial,
    'Retained native signing material',
  );
  if (lstatSync(retainedNativeSigningMaterial).size === 0) {
    throw new Error('Retained native signing material is empty');
  }
  const expectations = requireFile(root, transfer.expectations, 'Expectations');
  const expectationSize = lstatSync(expectations).size;
  if (expectationSize === 0 || expectationSize > 256 * 1024) {
    throw new Error('Expectations file must be non-empty and bounded');
  }
  parseExpectations(JSON.parse(readFileSync(expectations, 'utf8')) as unknown);
  return {
    root,
    recoverySet,
    currentFrontier,
    currentRelayDump,
    recipientPrivateKeyCustody,
    recoveryHmacKey,
    retainedNativeSigningMaterial,
    expectations,
  };
}

const inheritedEnvironmentAllowlist = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const;

/** Construct the restore child's environment without inheriting source credentials or paths. */
export function createIndependentRestoreChildEnvironment(
  environment: NodeJS.ProcessEnv,
  inputs: ResolvedIndependentRestoreInputs,
): NodeJS.ProcessEnv {
  const path = environment.PATH;
  if (!path || path.includes('\0')) throw new Error('Child environment requires a safe PATH');
  const home = join(inputs.root, 'child-home');
  const temp = join(inputs.root, 'child-tmp');
  for (const directory of [home, temp]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  realContainedPath(inputs.root, home, 'Child home');
  realContainedPath(inputs.root, temp, 'Child temporary directory');
  const child: NodeJS.ProcessEnv = {
    PATH: path,
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    GNUPGHOME: inputs.recipientPrivateKeyCustody,
  };
  for (const name of inheritedEnvironmentAllowlist.slice(1)) {
    const value = environment[name];
    if (value === undefined) continue;
    if (value.includes('\0') || value.length > 256) throw new Error(`Child environment ${name} is invalid`);
    child[name] = value;
  }
  return child;
}

/** Import a copied dump using a new, local, trust-authenticated QA cluster. */
export async function importCurrentRelay(value: unknown): Promise<ImportedCurrentRelay> {
  const transfer = assertCurrentRelayTransfer(value);
  const dump = resolve(repositoryRoot, transfer.relayDump);
  const tempRoot = realpathSync(join(repositoryRoot, '.temp'));
  realContainedPath(tempRoot, dump, 'Current relay dump');
  if (!existsSync(dump) || !lstatSync(dump).isFile()) throw new Error('Current relay dump is unavailable');
  const cluster = await startPostgresCluster({ role: 'postgres' });
  const url = `postgresql://postgres@127.0.0.1:${cluster.port}/relay`;
  try {
    execFileSync(
      'createdb',
      ['-h', '127.0.0.1', '-p', String(cluster.port), '-U', 'postgres', 'relay'],
      { timeout: 30_000 },
    );
    execFileSync(
      'pg_restore',
      ['--exit-on-error', '--no-owner', '--no-privileges', `--dbname=${url}`, dump],
      { timeout: 60_000 },
    );
    const relayPool = new Pool({ connectionString: url, max: 4 });
    relayPool.on('error', () => {});
    return {
      relayPool,
      identity: {
        host: '127.0.0.1',
        port: cluster.port,
        user: 'postgres',
        database: 'relay',
        clusterDirectory: cluster.directory,
      },
      close: async () => {
        await relayPool.end();
        cluster.remove();
      },
    };
  } catch (error) {
    cluster.remove();
    throw error;
  }
}
