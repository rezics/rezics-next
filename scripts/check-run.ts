#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  Aborted,
  executionCancellation,
  executionCancellationFromEnvironment,
  parseRemotePhysicalRunReceipt,
  readHosts,
  remoteCheck,
  requestExecutionCancellation,
  type ExecutionCancellation,
  type RemoteCheck,
  type RemotePhysicalRunReceipt,
  type Host,
  RemoteTransportError,
  REMOTE_TRANSPORT_FAILURE,
  workspaceFiles,
} from './remote-check.ts';
import {
  artifactRelativePath,
  CHECK_ARTIFACTS_MAX_BYTES,
  CHECK_ARTIFACTS_MAX_FILES,
  clearDeclaredArtifacts,
  validateArtifactDeclarations,
} from './check-artifacts.ts';
import { environmentCommandIsSafe, PERFORMANCE_HOST_NAMES, performanceHosts } from './check-placement.ts';

export type CheckRunArguments = {
  hosts: string;
  workspace: string;
  cwd: string;
  sourceRevision: string;
  envFile: string;
  returns: string[];
  command: string[];
};

export type CheckRunDependencies = {
  transport?: (options: RemoteCheck, signal: AbortSignal) => Promise<number>;
  receiptWriter?: (line: string) => void;
  cleanupWorktree?: (workspace: string, worktree: string, scratch: string) => void;
  onStarted?: (host: string) => void;
  onRetainSnapshot?: (snapshot: CandidateSnapshot) => void;
};

export type CandidateSnapshot = {
  workspace: string;
  sourceHash: string;
  inputFiles: string[];
  indexTree: string;
  scratch: string;
};

export class CheckRunUnavailable extends Error {
  readonly exitCode = REMOTE_TRANSPORT_FAILURE;
}

const FORBIDDEN_REMOTE_ENVIRONMENT = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SSH_AUTH_SOCK',
  'DISPLAY',
  'XAUTHORITY',
  'XDG_CACHE_HOME',
  'BUN_INSTALL_CACHE_DIR',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'KERNEL_CHECK_REMOTE',
  'KERNEL_CHECK_ON_REMOTE',
  'REMOTE_CHECK_HOST',
  'REMOTE_CHECK_RECEIPT_FD',
  'REMOTE_CHECK_RECEIPT_NONCE',
  'REMOTE_CHECK_CANCELLATION_FILE',
  'REMOTE_CHECK_CANCELLATION_ID',
  'REMOTE_CHECK_PRIORITY',
  'REMOTE_CHECK_POLL_MS',
  'REMOTE_CHECK_GATE',
  'REMOTE_CHECK_WAIT_REPEAT_MS',
  'REMOTE_CHECK_PREPARATION_TIMEOUT_MS',
  'REMOTE_CHECK_TRANSFER_TIMEOUT_MS',
  'REMOTE_CHECK_CONTROL_PROBE_TIMEOUT_MS',
  'REMOTE_CHECK_LIVENESS_INTERVAL_MS',
  'REMOTE_CHECK_PROGRESS_INTERVAL_MS',
  'REZICS_CHECK_LOCAL_ONLY',
  'REZICS_CHECK_MEMORY',
  'REZICS_CHECK_MEMORY_LEASE',
  'REZICS_CHECK_ID',
  'REZICS_CHECK_PHYSICAL_RUN_ID',
  'REZICS_CHECK_CANCEL_FILE',
  'REZICS_CHECK_STOP_FILE',
  'REZICS_CHECK_REMOTE_CUSTODY_FILE',
  'REZICS_CHECK_ARTIFACTS_DIR',
  'REZICS_CHECK_ARTIFACTS_PHYSICAL_RUN_ID',
  'REZICS_CHECK_MEMORY_DIR',
  'REZICS_CHECK_LEDGER_DIR',
  'REZICS_CHECK_PHASES',
  'REZICS_CHECK_ROOT',
  'REZICS_STACK_REMOTE',
  'REZICS_STACK_SLOT',
  'REZICS_STACK_LEASE',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'GOAL_TASK_ID',
  'GOAL_ATTEMPT',
]);

function absoluteDirectory(value: string, flag: string): string {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  const resolved = resolve(value);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) throw new Error(`${flag} is not a directory: ${value}`);
  return resolved;
}

function workspaceRelative(root: string, value: string, name: string): string {
  if (!value || isAbsolute(value)) throw new Error(`${name} must be a non-empty workspace-relative path`);
  const absolute = resolve(root, value);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    throw new Error(`${name} escapes the candidate workspace: ${value}`);
  return fromRoot || '.';
}

function candidateDirectory(root: string, value: string, name: string): string {
  const path = workspaceRelative(root, value, name);
  if (path === '.') return path;
  let current = root;
  for (const component of path.split(sep)) {
    current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new CheckRunUnavailable(`${name} does not exist in the candidate workspace: ${value}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new CheckRunUnavailable(`${name} must be a real candidate directory: ${value}`);
  }
  return path;
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    timeout: 30_000,
  });
  if (result.exitCode !== 0)
    throw new CheckRunUnavailable(`check-run: Git ${args[0] ?? 'operation'} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function gitList(root: string, args: string[]): string[] {
  const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    timeout: 30_000,
  });
  if (result.exitCode !== 0)
    throw new CheckRunUnavailable(`check-run: Git ${args[0] ?? 'operation'} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().split('\0').filter(Boolean);
}

function excludedTransferPath(file: string): boolean {
  const parts = file.split('/');
  return (
    parts[0] === '.git' ||
    parts[0] === '.temp' ||
    parts.includes('node_modules') ||
    parts.some((part) => ['build', 'dist', 'out', 'coverage', '.next', '.turbo', 'playwright-report', 'test-results'].includes(part))
  );
}

function sensitivePath(file: string): boolean {
  return file.split('/').some((part) => {
    const name = part.toLowerCase();
    return (
      name === '.env' ||
      (name.startsWith('.env.') && name !== '.env.example') ||
      ['.ssh', '.credentials', '.secrets', '.netrc', '.npmrc'].includes(name) ||
      /^id_(?:rsa|ed25519|ecdsa|dsa)$/.test(name) ||
      /\.(?:key|p12|pfx|jks|keystore)$/.test(name)
    );
  });
}

function hasPrivateKeyMaterial(file: string): boolean {
  const descriptor = openSync(file, 'r');
  const bytes = Buffer.alloc(16 * 1024);
  let length: number;
  try {
    length = readSync(descriptor, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(descriptor);
  }
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(bytes.subarray(0, length).toString('utf8'));
}

function assertCandidateInputs(root: string, excludedPaths: readonly string[]): void {
  const listed = gitList(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  for (const file of listed) {
    if (
      excludedTransferPath(file) ||
      excludedPaths.some((path) => file === path || file.startsWith(`${path}/`))
    )
      continue;
    const absolute = resolve(root, file);
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isFile() && !stats.isSymbolicLink())
      throw new CheckRunUnavailable(`check-run: unsupported candidate input type: ${file}`);
    if (sensitivePath(file))
      throw new CheckRunUnavailable(`check-run: candidate contains protected credential or host-local input: ${file}`);
    if (stats.isSymbolicLink()) {
      assertContainedSymlink(root, absolute, readlinkSync(absolute));
    } else if (hasPrivateKeyMaterial(absolute)) {
      throw new CheckRunUnavailable(`check-run: candidate contains private key material: ${file}`);
    }
  }
}

function assertContainedSymlink(root: string, absolute: string, target: string): void {
  if (isAbsolute(target)) throw new CheckRunUnavailable(`check-run: absolute source symlink is not portable: ${relative(root, absolute)}`);
  const resolvedTarget = resolve(dirname(absolute), target);
  const inside = relative(root, resolvedTarget);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new CheckRunUnavailable(`check-run: source symlink escapes the workspace: ${relative(root, absolute)}`);
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const reader = Bun.file(file).stream().getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hash.update(chunk.value);
  }
  return hash.digest('hex');
}

async function inputFingerprint(
  root: string,
  files = workspaceFiles(root),
  excludedPaths: readonly string[] = [],
): Promise<string> {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    if (excludedPaths.some((path) => file === path || file.startsWith(`${path}/`))) continue;
    const absolute = resolve(root, file);
    const inside = relative(root, absolute);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new CheckRunUnavailable(`check-run: Git listed an input outside the workspace: ${file}`);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      continue; // A tracked deletion is part of the prepared snapshot and is recorded below.
    }
    hash.update(`${file}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      assertContainedSymlink(root, absolute, target);
      hash.update(`link\0${target}\0`);
    }
    else if (stat.isFile()) hash.update(`file\0${await hashFile(absolute)}\0`);
    else throw new CheckRunUnavailable(`check-run: unsupported source input type: ${file}`);
  }
  for (const file of gitList(root, ['ls-files', '--deleted', '-z'])) {
    if (excludedTransferPath(file) || excludedPaths.some((path) => file === path || file.startsWith(`${path}/`))) continue;
    hash.update(`deleted\0${file}\0`);
  }
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const indexTree = git(root, ['write-tree']);
  hash.update(`HEAD\0${head}\0index\0${indexTree}\0`);
  return hash.digest('hex');
}

function ensureSafeParent(root: string, relativePath: string): string {
  const parts = relativePath.split(/[\\/]/);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        rmSync(current, { recursive: true, force: true });
        mkdirSync(current, { recursive: true, mode: 0o700 });
      }
    } catch {
      mkdirSync(current, { recursive: true, mode: 0o700 });
    }
  }
  return join(root, ...parts);
}

function ensureSafeDestinationParent(root: string, relativePath: string): string {
  const parts = relativePath.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new CheckRunUnavailable(`check-run: declared output parent is unsafe: ${relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return join(root, ...parts);
}

function removeCandidateFile(root: string, path: string): void {
  const target = ensureSafeParent(root, path);
  rmSync(target, { recursive: true, force: true });
}

function validateNonOverlappingReturns(paths: readonly string[]): string[] {
  const declarations = validateArtifactDeclarations(paths);
  for (const path of declarations) {
    if (sensitivePath(path))
      throw new CheckRunUnavailable(`check-run: declared return path is protected credential or host-local data: ${path}`);
  }
  for (let index = 0; index < declarations.length; index += 1) {
    for (let other = index + 1; other < declarations.length; other += 1) {
      const left = declarations[index]!;
      const right = declarations[other]!;
      if (left.startsWith(`${right}/`) || right.startsWith(`${left}/`))
        throw new Error(`check-run: declared return paths overlap: ${left} and ${right}`);
    }
  }
  return declarations;
}

async function copyFrozenInput(sourceRoot: string, targetRoot: string, file: string): Promise<void> {
  const source = resolve(sourceRoot, file);
  const target = ensureSafeParent(targetRoot, file);
  let stat;
  try {
    stat = lstatSync(source);
  } catch {
    removeCandidateFile(targetRoot, file);
    return;
  }
  rmSync(target, { recursive: true, force: true });
  if (stat.isSymbolicLink()) {
    const beforeTarget = readlinkSync(source);
    assertContainedSymlink(sourceRoot, source, beforeTarget);
    symlinkSync(beforeTarget, target);
    if (beforeTarget !== readlinkSync(source))
      throw new CheckRunUnavailable(`check-run: candidate symlink changed while preparing: ${file}`);
    return;
  }
  if (!stat.isFile()) throw new CheckRunUnavailable(`check-run: unsupported source input type: ${file}`);
  const before = await hashFile(source);
  copyFileSync(source, target);
  chmodSync(target, stat.mode & 0o777);
  const after = await hashFile(source);
  const frozen = await hashFile(target);
  if (before !== after || before !== frozen)
    throw new CheckRunUnavailable(`check-run: candidate input changed while preparing: ${file}`);
}

/** Freeze the exact tracked/untracked source bytes in an isolated native worktree before remote transfer. */
export async function prepareCandidateSnapshot(
  workspace: string,
  sourceRevision: string,
  scratchParent?: string,
  excludedInputs: readonly string[] = [],
): Promise<CandidateSnapshot> {
  const root = resolve(workspace);
  const repositoryRoot = resolve(git(root, ['rev-parse', '--show-toplevel']));
  if (repositoryRoot !== root)
    throw new CheckRunUnavailable(`check-run: --workspace must be the candidate Git root (received ${root})`);
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision) || head !== sourceRevision)
    throw new CheckRunUnavailable(`check-run: source revision mismatch (requested ${sourceRevision}, candidate ${head})`);
  assertCandidateInputs(root, excludedInputs);
  const files = workspaceFiles(root);
  const beforeFingerprint = await inputFingerprint(root, files, excludedInputs);
  const indexTree = git(root, ['write-tree']);
  const baseFiles = gitList(root, ['ls-tree', '-rz', '--name-only', head]);
  const scratchBase = scratchParent ?? join(root, '.temp');
  mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(scratchBase, `check-run-${randomUUID()}-`));
  chmodSync(scratch, 0o700);
  const frozen = join(scratch, 'workspace');
  let worktreeRegistered = false;
  try {
    const add = Bun.spawnSync(
      ['git', '-c', 'core.hooksPath=/dev/null', '-C', root, 'worktree', 'add', '--detach', frozen, head],
      { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000 },
    );
    if (add.exitCode !== 0)
      throw new CheckRunUnavailable(`check-run: candidate worktree preparation failed: ${add.stderr.toString().trim()}`);
    worktreeRegistered = true;
    const selected = new Set(files);
    for (const tracked of baseFiles) if (!selected.has(tracked)) removeCandidateFile(frozen, tracked);
    for (const excluded of excludedInputs) removeCandidateFile(frozen, excluded);
    for (const file of files) {
      if (excludedInputs.some((excluded) => file === excluded || file.startsWith(`${excluded}/`))) continue;
      await copyFrozenInput(root, frozen, file);
    }
    const frozenIndex = git(frozen, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const readTree = Bun.spawnSync(
      ['git', '-c', 'core.hooksPath=/dev/null', '-C', frozen, 'read-tree', indexTree],
      { cwd: frozen, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
    );
    if (readTree.exitCode !== 0)
      throw new CheckRunUnavailable(`check-run: candidate index snapshot could not be prepared: ${readTree.stderr.toString().trim()}`);
    if (!existsSync(frozenIndex)) throw new CheckRunUnavailable('check-run: frozen native index is missing');
    const afterFingerprint = await inputFingerprint(root, files, excludedInputs);
    const frozenFingerprint = await inputFingerprint(frozen, workspaceFiles(frozen), excludedInputs);
    if (beforeFingerprint !== afterFingerprint || beforeFingerprint !== frozenFingerprint)
      throw new CheckRunUnavailable('check-run: candidate source changed while preparing its frozen snapshot');
    return { workspace: frozen, sourceHash: frozenFingerprint, inputFiles: files, indexTree, scratch };
  } catch (error) {
    if (worktreeRegistered) {
      Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-C', root, 'worktree', 'remove', '--force', frozen], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
    }
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

export function readEnvironmentFile(file: string, workspace: string): Record<string, string> {
  if (!isAbsolute(file)) throw new Error('--env-file must be an absolute path');
  const absolute = resolve(file);
  const inside = relative(workspace, absolute);
  if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)))
    throw new Error('--env-file must be outside the candidate workspace');
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('--env-file must be a private regular file with mode 0600 or stricter');
  if (stat.size > 1024 * 1024) throw new Error('--env-file exceeds the 1 MiB environment bound');
  const value: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('--env-file must contain a JSON object');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 256) throw new Error('--env-file contains too many environment values');
  const output: Record<string, string> = {};
  for (const [name, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof item !== 'string' || item.includes('\0'))
      throw new Error(`--env-file has an invalid string value for ${name}`);
    if (FORBIDDEN_REMOTE_ENVIRONMENT.has(name))
      throw new CheckRunUnavailable(`check-run: environment value ${name} is host-local or placement authority`);
    if (
      name.startsWith('KERNEL_CHECK_') ||
      name.startsWith('REMOTE_CHECK_') ||
      name.startsWith('REZICS_CHECK_') ||
      name.startsWith('REZICS_STACK_') ||
      name.startsWith('BUN_')
    )
      throw new CheckRunUnavailable(`check-run: environment value ${name} is host-local or placement authority`);
    if (name.startsWith('GOAL_') || name.startsWith('CODEX_'))
      throw new CheckRunUnavailable(`check-run: environment value ${name} contains local task or session authority`);
    output[name] = item;
  }
  return output;
}

function relocateEnvironment(
  values: Record<string, string>,
  sourceWorkspace: string,
  targetWorkspace: string,
  cwd: string,
): Record<string, string> {
  const relocated = { ...values };
  for (const [name, value] of Object.entries(relocated)) {
    if (!isAbsolute(value)) continue;
    const inside = relative(sourceWorkspace, resolve(value));
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new CheckRunUnavailable(`check-run: host-absolute environment dependency ${name} is unsupported`);
    const pathLike = name === 'GROWTH_PROFILE' || /(?:_FILE|_PATH|_DIR|_ROOT)$/.test(name);
    if (!pathLike)
      throw new CheckRunUnavailable(`check-run: absolute environment dependency ${name} is not a declared workspace path`);
    relocated[name] = relative(resolve(targetWorkspace, cwd), resolve(targetWorkspace, inside)) || '.';
  }
  return relocated;
}

function preparationCommands(workspace: string, cwd: string, argv: readonly string[]): RemoteCheck['prepare'] {
  const referencedDirectories = new Set<string>([cwd]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--cwd' && argv[index + 1]) referencedDirectories.add(argv[index + 1]!);
    else if (argument.startsWith('--cwd=')) referencedDirectories.add(argument.slice('--cwd='.length));
    if (argument === 'apps/web' || argument.startsWith('apps/web/')) referencedDirectories.add('apps/web');
    if (argument === 'apps/auth' || argument.startsWith('apps/auth/')) referencedDirectories.add('apps/auth');
  }
  const packages = ['apps/web', 'apps/auth'].filter((path) =>
    [...referencedDirectories].some((directory) => directory === path || directory.startsWith(`${path}/`)),
  );
  const commands: NonNullable<RemoteCheck['prepare']> = [];
  for (const path of packages) {
    const manifestPath = join(workspace, path, 'package.json');
    let stat;
    try {
      stat = lstatSync(manifestPath);
    } catch {
      throw new CheckRunUnavailable(`check-run: required generated-input package is missing: ${path}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024)
      throw new CheckRunUnavailable(`check-run: generated-input package manifest is not a bounded regular file: ${path}`);
    let parsed: { scripts?: Record<string, unknown> };
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { scripts?: Record<string, unknown> };
    } catch (error) {
      throw new CheckRunUnavailable(
        `check-run: generated-input package manifest is invalid for ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const script of ['generate', 'generate:routes']) {
      if (typeof parsed.scripts?.[script] !== 'string')
        throw new CheckRunUnavailable(`check-run: ${path} does not declare ${script} preparation`);
      commands.push({ cwd: '.', command: ['bun', 'run', '--cwd', path, script] });
    }
  }
  return commands;
}

function parseReceiptChannel(env: NodeJS.ProcessEnv): { nonce: string; write: (line: string) => void } | undefined {
  const fd = env.REMOTE_CHECK_RECEIPT_FD;
  const nonce = env.REMOTE_CHECK_RECEIPT_NONCE;
  if (fd === undefined && nonce === undefined) return undefined;
  if (fd !== '3' || !nonce || nonce.length > 256) throw new Error('check-run: invalid trusted receipt channel');
  return {
    nonce,
    write: (line) => {
      writeSync(3, line);
    },
  };
}

export function parseCheckRunArguments(argv: readonly string[]): CheckRunArguments {
  const args = [...argv];
  const result: Partial<CheckRunArguments> = { returns: [] };
  while (args[0]?.startsWith('--') && args[0] !== '--') {
    const flag = args.shift()!;
    if (flag === '--returns') {
      const value = args.shift();
      if (!value) throw new Error('--returns requires a workspace-relative path');
      result.returns!.push(value);
      continue;
    }
    const value = args.shift();
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--hosts') result.hosts = value;
    else if (flag === '--workspace') result.workspace = value;
    else if (flag === '--cwd') result.cwd = value;
    else if (flag === '--source-revision') result.sourceRevision = value;
    else if (flag === '--env-file') result.envFile = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (args.shift() !== '--' || args.length === 0) throw new Error('check-run requires -- <original-argv...>');
  result.command = args;
  for (const name of ['hosts', 'workspace', 'cwd', 'sourceRevision', 'envFile'] as const) {
    if (typeof result[name] !== 'string' || !result[name]) throw new Error(`check-run requires --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return result as CheckRunArguments;
}

function cleanupWorktree(workspace: string, worktree: string, scratch: string): void {
  const result = Bun.spawnSync(
    ['git', '-c', 'core.hooksPath=/dev/null', '-C', workspace, 'worktree', 'remove', '--force', worktree],
    { cwd: workspace, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new CheckRunUnavailable(`check-run: frozen worktree cleanup failed: ${result.stderr.toString().trim()}`);
  rmSync(scratch, { recursive: true, force: true });
}

type ReturnedOutputResult = { missing: string[]; rejected: string[] };

async function hashTree(path: string): Promise<string> {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`symlink returned for ${path}`);
  if (stats.isFile()) return hashFile(path);
  if (!stats.isDirectory()) throw new Error(`special file returned for ${path}`);
  const hash = createHash('sha256');
  for (const child of readdirSync(path).sort()) hash.update(`${child}\0${await hashTree(join(path, child))}\0`);
  return hash.digest('hex');
}

async function copyReturnedOutputs(
  sourceRoot: string,
  destinationRoot: string,
  stageRoot: string,
  physicalRunId: string,
  returns: readonly string[],
): Promise<ReturnedOutputResult> {
  const result: ReturnedOutputResult = { missing: [], rejected: [] };
  if (returns.length === 0) return result;
  mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  let totalFiles = 0;
  let totalBytes = 0;
  let examinedEntries = 0;
  const staged: string[] = [];

  const copyTree = async (source: string, stagePath: string): Promise<void> => {
    artifactRelativePath(stagePath);
    examinedEntries += 1;
    if (examinedEntries > CHECK_ARTIFACTS_MAX_FILES * 1024)
      throw new Error('returned output exceeds the traversal bound');
    const stats = lstatSync(source);
    if (sensitivePath(stagePath)) throw new Error('credential or host-local data in returned output');
    if (stats.isSymbolicLink()) throw new Error('symlink in returned output');
    const destination = ensureSafeParent(stageRoot, stagePath);
    if (stats.isDirectory()) {
      mkdirSync(destination, { recursive: true, mode: stats.mode & 0o777 });
      for (const child of readdirSync(source).sort()) await copyTree(join(source, child), `${stagePath}/${child}`);
      return;
    }
    if (!stats.isFile()) throw new Error('special file in returned output');
    if (hasPrivateKeyMaterial(source)) throw new Error('private key material in returned output');
    totalFiles += 1;
    totalBytes += stats.size;
    if (totalFiles > CHECK_ARTIFACTS_MAX_FILES || totalBytes > CHECK_ARTIFACTS_MAX_BYTES)
      throw new Error('returned output exceeds the file-count or byte bound');
    const before = await hashFile(source);
    copyFileSync(source, destination);
    chmodSync(destination, stats.mode & 0o777);
    if (before !== (await hashFile(source)) || before !== (await hashFile(destination)))
      throw new Error(`returned output changed while copying: ${stagePath}`);
  };

  for (const path of returns) {
    const source = resolve(sourceRoot, path);
    try {
      lstatSync(source);
      await copyTree(source, path);
      staged.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.missing.push(path);
      else result.rejected.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const path of staged) {
    const source = resolve(stageRoot, path);
    const destination = ensureSafeDestinationParent(destinationRoot, path);
    rmSync(destination, { recursive: true, force: true });
    const temporary = `${destination}.${randomUUID()}.return`;
    try {
      const before = await hashTree(source);
      copyFileOrTree(source, temporary);
      if (before !== (await hashTree(source)) || before !== (await hashTree(temporary)))
        throw new Error(`returned output changed while restoring: ${path}`);
      renameSync(temporary, destination);
      process.stderr.write(`check-run: returned physical=${physicalRunId} path=${JSON.stringify(path)}\n`);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      result.rejected.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const path of result.missing) process.stderr.write(`check-run: declared output missing: ${path}\n`);
  for (const path of result.rejected) process.stderr.write(`check-run: declared output rejected: ${path}\n`);
  return result;
}

function copyFileOrTree(source: string, destination: string): void {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) throw new Error(`symlink returned for ${source}`);
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: stats.mode & 0o777 });
    for (const child of readdirSync(source).sort()) copyFileOrTree(join(source, child), join(destination, child));
    return;
  }
  if (!stats.isFile()) throw new Error(`special file returned for ${source}`);
  copyFileSync(source, destination);
  chmodSync(destination, stats.mode & 0o777);
}

function resolveEnvironmentFileSettings(
  values: Record<string, string>,
  sourceWorkspace: string,
  targetWorkspace: string,
  cwd: string,
): Record<string, string> {
  return relocateEnvironment(values, sourceWorkspace, targetWorkspace, cwd);
}

export async function runCheck(
  args: CheckRunArguments,
  dependencies: CheckRunDependencies = {},
  signal = new AbortController().signal,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const trustedRoot = resolve(import.meta.dir, '..');
  const candidateRoot = absoluteDirectory(args.workspace, '--workspace');
  if (resolve(candidateRoot) === trustedRoot)
    throw new CheckRunUnavailable('check-run: trusted driver root and candidate workspace must be separate');
  if (!isAbsolute(args.hosts)) throw new Error('--hosts must name an absolute JSON file');
  const hostsFile = resolve(args.hosts);
  if (!existsSync(hostsFile) || !lstatSync(hostsFile).isFile())
    throw new Error('--hosts must name an existing absolute JSON file');
  const hostsInside = relative(candidateRoot, hostsFile);
  if (hostsInside === '' || (!hostsInside.startsWith(`..${sep}`) && hostsInside !== '..' && !isAbsolute(hostsInside)))
    throw new CheckRunUnavailable('--hosts must be outside the candidate workspace');
  const hosts: Host[] = performanceHosts(readHosts(hostsFile));
  if (hosts.length === 0) throw new CheckRunUnavailable('--hosts contains no approved a/b host');
  const cwd = candidateDirectory(candidateRoot, args.cwd, '--cwd');
  const returns = validateNonOverlappingReturns(
    args.returns.map((path) => workspaceRelative(candidateRoot, path, '--returns')),
  );
  if (args.command.length === 0 || args.command.length > 1024 || args.command.some((argument) => argument.length > 4096))
    throw new Error('check-run: original argv exceeds its argument bounds');
  if (new TextEncoder().encode(JSON.stringify(args.command)).byteLength > 16 * 1024)
    throw new Error('check-run: original argv exceeds its encoded size bound');
  if (!environmentCommandIsSafe(args.command))
    throw new CheckRunUnavailable('check-run: original env prefix changes remote runtime or placement authority');
  const sourceRevision = args.sourceRevision;
  const originalEnvironment = readEnvironmentFile(args.envFile, candidateRoot);
  const frozenArgs = [...args.command];
  const cancellation: ExecutionCancellation | undefined = executionCancellationFromEnvironment(processEnvironment);
  const receiptChannel = parseReceiptChannel(processEnvironment);
  const requestedPriority = processEnvironment.REMOTE_CHECK_PRIORITY;
  if (requestedPriority !== undefined && requestedPriority !== 'landing' && requestedPriority !== 'critical')
    throw new CheckRunUnavailable('check-run: invalid REMOTE_CHECK_PRIORITY');
  if (signal.aborted) return 130;
  const snapshot = await prepareCandidateSnapshot(candidateRoot, sourceRevision, join(trustedRoot, '.temp'), returns);
  const receiptNonce = receiptChannel?.nonce;
  const writeReceipt = dependencies.receiptWriter ?? receiptChannel?.write;
  let receivedReceipt: RemotePhysicalRunReceipt | undefined;
  let receiptForwardFailure: unknown;
  let outcome = REMOTE_TRANSPORT_FAILURE;
  let runFailure: unknown;
  let cleanupFailure: unknown;
  let returnFailure: unknown;
  let transportStarted = false;
  let terminalConfirmed = false;
  try {
    const overlay = resolveEnvironmentFileSettings(originalEnvironment, candidateRoot, snapshot.workspace, cwd);
    const preparation = preparationCommands(snapshot.workspace, cwd, frozenArgs);
    const producerSourceHash = await hashFile(resolve(import.meta.path));
    const hostConfigurationHash = await hashFile(hostsFile);
    const preparationHash = createHash('sha256').update(JSON.stringify(preparation ?? [])).digest('hex');
    const sourceEnvironmentHash = createHash('sha256')
      .update(JSON.stringify(Object.entries(originalEnvironment).sort(([left], [right]) => left.localeCompare(right))))
      .digest('hex');
    const environmentIdentity = {
      values: Object.entries(overlay).sort(([left], [right]) => left.localeCompare(right)),
      priority: requestedPriority ?? null,
    };
    const environmentHash = createHash('sha256').update(JSON.stringify(environmentIdentity)).digest('hex');
    const commandHash = createHash('sha256').update(JSON.stringify(frozenArgs)).digest('hex');
    process.stderr.write(
      `check-run: placement identity ${JSON.stringify({
        producerSha256: producerSourceHash,
        sourceRevision,
        sourceSha256: snapshot.sourceHash,
        cwd,
        hostsSha256: hostConfigurationHash,
        preparationSha256: preparationHash,
        sourceEnvironmentSha256: sourceEnvironmentHash,
        environmentSha256: environmentHash,
        commandSha256: commandHash,
        priority: requestedPriority ?? null,
      })}\n`,
    );
    const remoteOptions: RemoteCheck = {
      hosts,
      allowedHosts: [...PERFORMANCE_HOST_NAMES],
      hostsFile,
      workspace: snapshot.workspace,
      cwd,
      command: ['env', ...Object.entries(overlay).map(([name, value]) => `${name}=${value}`), ...frozenArgs],
      returns,
      ...(preparation.length === 0 ? {} : { prepare: preparation }),
      ...(cancellation === undefined ? {} : { cancellation }),
      ...(requestedPriority === undefined ? {} : { priority: requestedPriority }),
      started: (host) => {
        if (signal.aborted || executionCancellation(cancellation))
          throw new Aborted('check-run: cancelled command cannot start');
        if (host !== 'a' && host !== 'b') throw new CheckRunUnavailable(`check-run: remote transport selected forbidden host ${host}`);
        dependencies.onStarted?.(host);
      },
      completed: (receipt) => {
        const parsed = parseRemotePhysicalRunReceipt(receipt);
        if (!parsed || !['a', 'b'].includes(parsed.host))
          throw new CheckRunUnavailable('check-run: remote terminal receipt is invalid or names a forbidden host');
        receivedReceipt = parsed;
        if (writeReceipt && receiptNonce) {
          try {
            writeReceipt(`${JSON.stringify({ nonce: receiptNonce, receipt: parsed })}\n`);
          } catch (error) {
            receiptForwardFailure = error;
          }
        }
      },
    };
    const transport = dependencies.transport ?? remoteCheck;
    transportStarted = true;
    outcome = await transport(remoteOptions, signal);
    if (!receivedReceipt && (signal.aborted || executionCancellation(cancellation))) {
      outcome = 128 + (executionCancellation(cancellation)?.signal ?? 2);
    } else {
      if (!receivedReceipt) throw new CheckRunUnavailable('check-run: remote terminal receipt is missing');
      if (receivedReceipt.exitCode !== outcome)
        throw new CheckRunUnavailable('check-run: remote terminal receipt does not match the native command status');
      terminalConfirmed = true;
      try {
        clearDeclaredArtifacts(candidateRoot, returns);
        const returned = await copyReturnedOutputs(
          snapshot.workspace,
          candidateRoot,
          join(snapshot.scratch, 'returns'),
          receivedReceipt.run,
          returns,
        );
        if (returned.missing.length || returned.rejected.length) {
          returnFailure = new CheckRunUnavailable('check-run: one or more declared outputs were not restored');
          if (outcome === 0) outcome = 1;
        }
      } catch (error) {
        returnFailure = error;
        if (outcome === 0) outcome = 1;
      }
      if (receiptForwardFailure) {
        runFailure = new CheckRunUnavailable(
          `check-run: authenticated receipt could not be forwarded: ${receiptForwardFailure instanceof Error ? receiptForwardFailure.message : String(receiptForwardFailure)}`,
        );
        if (outcome === 0) outcome = REMOTE_TRANSPORT_FAILURE;
      }
    }
  } catch (error) {
    runFailure = error;
    if (error instanceof Aborted) outcome = 128 + (executionCancellation(cancellation)?.signal ?? 2);
    else if (receivedReceipt && receivedReceipt.exitCode !== 0) outcome = receivedReceipt.exitCode;
    else if (
      error instanceof RemoteTransportError ||
      (error instanceof Error && error.message === 'remote-check: no check host answered')
    )
      outcome = REMOTE_TRANSPORT_FAILURE;
    else if (error instanceof CheckRunUnavailable) outcome = error.exitCode;
    else outcome = 1;
  } finally {
    try {
      const frozenFingerprint = await inputFingerprint(snapshot.workspace, workspaceFiles(snapshot.workspace), returns);
      if (frozenFingerprint !== snapshot.sourceHash)
        throw new CheckRunUnavailable('check-run: frozen candidate inputs changed while the remote run was active');
      const currentFingerprint = await inputFingerprint(candidateRoot, workspaceFiles(candidateRoot), returns);
      if (currentFingerprint !== snapshot.sourceHash)
        throw new CheckRunUnavailable('check-run: candidate inputs changed while the remote run was active');
    } catch (error) {
      runFailure ??= error;
      if (outcome === 0) outcome = error instanceof CheckRunUnavailable ? error.exitCode : 1;
    }
    if (!transportStarted || terminalConfirmed) {
      try {
        (dependencies.cleanupWorktree ?? cleanupWorktree)(candidateRoot, snapshot.workspace, snapshot.scratch);
      } catch (error) {
        cleanupFailure = error;
        process.stderr.write(`check-run: frozen source cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        if (outcome === 0) outcome = 1;
      }
    } else {
      process.stderr.write(
        `check-run: remote physical terminality is unknown; retaining frozen workspace=${snapshot.workspace} source-sha256=${snapshot.sourceHash}\n`,
      );
      try {
        dependencies.onRetainSnapshot?.(snapshot);
      } catch (error) {
        process.stderr.write(`check-run: retained snapshot observer failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
  if (runFailure) {
    const detail = runFailure instanceof Error ? runFailure.message : String(runFailure);
    if (cleanupFailure) process.stderr.write(`check-run: command failure: ${detail}\n`);
    else process.stderr.write(`${detail}\n`);
  }
  if (returnFailure) {
    const detail = returnFailure instanceof Error ? returnFailure.message : String(returnFailure);
    if (runFailure) process.stderr.write(`check-run: return failure: ${detail}\n`);
    else process.stderr.write(`${detail}\n`);
  }
  return outcome;
}

function usage(): string {
  return 'Usage: bun scripts/check-run.ts --hosts <absolute-hosts-json> --workspace <absolute-candidate-root> --cwd <workspace-relative-directory> --source-revision <full-candidate-commit> --env-file <absolute-environment-json> [--returns <workspace-relative-path>]... -- <original-argv...>';
}

if (import.meta.main) {
  const controller = new AbortController();
  const cancellation = executionCancellationFromEnvironment();
  let received: 1 | 2 | 15 | undefined;
  for (const [name, number] of [
    ['SIGHUP', 1],
    ['SIGINT', 2],
    ['SIGTERM', 15],
  ] as const) {
    process.on(name, () => {
      received ??= number;
      if (cancellation) requestExecutionCancellation(cancellation, number);
      controller.abort();
    });
  }
  try {
    process.exitCode = await runCheck(parseCheckRunArguments(process.argv.slice(2)), {}, controller.signal);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(usage());
    process.exitCode = error instanceof CheckRunUnavailable ? error.exitCode : 2;
  }
  if (received !== undefined) process.exitCode = 128 + received;
}
