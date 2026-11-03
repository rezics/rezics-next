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
  realpathSync,
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
  repositoryBun,
  requestExecutionCancellation,
  type ExecutionCancellation,
  type RemoteCheck,
  type Host,
  RemoteTransportError,
  REMOTE_TRANSPORT_FAILURE,
  reconcileRemoteRun,
  workspaceFiles,
} from './remote-check.ts';
import type {
  RemoteCheckSettlement,
  RemotePreparedInputsEvidence,
  RemotePhysicalRunReceipt,
  RemoteReturnManifest,
} from './remote-check.ts';
import {
  artifactRelativePath,
  CHECK_ARTIFACTS_MAX_BYTES,
  CHECK_ARTIFACTS_MAX_FILES,
  clearDeclaredArtifacts,
  validateArtifactDeclarations,
} from './check-artifacts.ts';
import {
  KERNEL_CLIENT_OUTPUT,
  outputTreeInputExclusions,
  outputTreeProfile,
  outputTreeTransportCandidates,
  receiveOutputTrees,
  safeOutputTreePath,
  type OutputTreeBinding,
} from './check-output-tree.ts';
import { environmentCommandIsSafe, performanceHosts } from './check-placement.ts';
import {
  allocateCheckRunPhysical,
  beginCheckRunAllocation,
  bindCheckRunWorkspace,
  cancelCheckRunInvocation,
  claimCheckRunPreparedInvocation,
  checkRunBindingHash,
  checkRunSettlementStateDirectory,
  createCheckRunFinalSettlement,
  createCheckRunNativeTerminalMessage,
  discardCheckRunPreparedExecution,
  discardCheckRunPreparationIntent,
  encodeCheckRunFinalSettlement,
  getCheckRunStatus,
  checkRunNativeReceiptDigest,
  markCheckRunPreparedSnapshotCustody,
  markCheckRunFinalSettlementDelivery,
  markCheckRunNativeTerminal,
  persistCheckRunPreparedInvocation,
  readCheckRunPreparedDescriptor,
  readCheckRunPreparedDescriptorReference,
  readCheckRunCancellation,
  readCheckRunPreparationIntentReference,
  reconcileCheckRunInvocation,
  registerCheckRunInvocation,
  setCheckRunUnknown,
  checkRunPreparationIntentFile,
  removeCheckRunPreparationIntentFile,
  writeCheckRunPreparationIntent,
  type CheckRunPreparationIntent,
  stageCheckRunFinalSettlement,
  withCheckRunSpawnPermit,
  type CheckRunCleanupDisposition,
  type CheckRunFinalSettlement,
  type CheckRunInvocationBinding,
  type CheckRunInvocationRecord,
  type CheckRunPreparedDescriptor,
  type CheckRunPreparedInputs,
  type CheckRunReturnDisposition,
  type CheckRunStateOptions,
  type CheckRunTransportChildIdentity,
} from './check-run-settlement.ts';

export type CheckRunArguments = {
  hosts: string;
  workspace: string;
  cwd: string;
  sourceRevision: string;
  envFile: string;
  returns: string[];
  command: string[];
};

export type { CheckRunPreparedDescriptor } from './check-run-settlement.ts';

export type CheckRunDependencies = {
  transport?: (options: RemoteCheck, signal: AbortSignal) => Promise<number>;
  receiptWriter?: (line: string) => void;
  settlementWriter?: (line: string) => void;
  stateDirectory?: string;
  onDurableCancellationReady?: (cancel: (signal: 1 | 2 | 15) => Promise<void>) => void;
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

function isAdmittedCheckRunHost(host: string, hosts: readonly Host[]): boolean {
  return hosts.some((configured) => configured.performance === true && configured.name === host);
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
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'DEBUGINFOD_IMA_CERT_PATH',
  'MOZ_GMP_PATH',
  'XDG_CACHE_HOME',
  'BUN_INSTALL_CACHE_DIR',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'KERNEL_CHECK_REMOTE',
  'KERNEL_CHECK_ON_REMOTE',
  'REMOTE_CHECK_HOST',
  'REMOTE_CHECK_RECEIPT_FD',
  'REMOTE_CHECK_RECEIPT_NONCE',
  'REMOTE_CHECK_INVOCATION_ID',
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
  'NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'GOAL_TASK_ID',
  'GOAL_ATTEMPT',
]);

function absoluteDirectory(value: string, flag: string): string {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  const resolved = resolve(value);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory())
    throw new Error(`${flag} is not a directory: ${value}`);
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
    throw new CheckRunUnavailable(
      `check-run: Git ${args[0] ?? 'operation'} failed: ${result.stderr.toString().trim()}`,
    );
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
    throw new CheckRunUnavailable(
      `check-run: Git ${args[0] ?? 'operation'} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString().split('\0').filter(Boolean);
}

function excludedTransferPath(file: string): boolean {
  const parts = file.split('/');
  return (
    parts[0] === '.git' ||
    parts[0] === '.temp' ||
    parts.includes('node_modules') ||
    parts.some((part) =>
      ['build', 'dist', 'out', 'coverage', '.next', '.turbo', 'playwright-report', 'test-results'].includes(part),
    )
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
    if (excludedTransferPath(file) || excludedPaths.some((path) => file === path || file.startsWith(`${path}/`)))
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
    } else if (
      // That test writes a fake key fixture; branches cut before its literal was split still carry it.
      file !== 'scripts/check-run.test.ts' &&
      hasPrivateKeyMaterial(absolute)
    ) {
      throw new CheckRunUnavailable(`check-run: candidate contains private key material: ${file}`);
    }
  }
}

function assertContainedSymlink(root: string, absolute: string, target: string): void {
  if (isAbsolute(target))
    throw new CheckRunUnavailable(`check-run: absolute source symlink is not portable: ${relative(root, absolute)}`);
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
  excludedPaths = outputTreeInputExclusions(excludedPaths);
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
    } else if (stat.isFile()) hash.update(`file\0${await hashFile(absolute)}\0`);
    else throw new CheckRunUnavailable(`check-run: unsupported source input type: ${file}`);
  }
  for (const file of gitList(root, ['ls-files', '--deleted', '-z'])) {
    if (excludedTransferPath(file) || excludedPaths.some((path) => file === path || file.startsWith(`${path}/`)))
      continue;
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
      throw new CheckRunUnavailable(
        `check-run: declared return path is protected credential or host-local data: ${path}`,
      );
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
  allocation?: { workspace: string; scratch: string },
): Promise<CandidateSnapshot> {
  excludedInputs = outputTreeInputExclusions(excludedInputs);
  const root = resolve(workspace);
  const repositoryRoot = resolve(git(root, ['rev-parse', '--show-toplevel']));
  if (repositoryRoot !== root)
    throw new CheckRunUnavailable(`check-run: --workspace must be the candidate Git root (received ${root})`);
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision) || head !== sourceRevision)
    throw new CheckRunUnavailable(
      `check-run: source revision mismatch (requested ${sourceRevision}, candidate ${head})`,
    );
  assertCandidateInputs(root, excludedInputs);
  const files = workspaceFiles(root);
  const beforeFingerprint = await inputFingerprint(root, files, excludedInputs);
  const indexTree = git(root, ['write-tree']);
  const baseFiles = gitList(root, ['ls-tree', '-rz', '--name-only', head]);
  const scratchBase = scratchParent ?? join(root, '.temp');
  mkdirSync(scratchBase, { recursive: true, mode: 0o700 });
  const scratch = allocation
    ? resolve(allocation.scratch)
    : mkdtempSync(join(scratchBase, `check-run-${randomUUID()}-`));
  if (allocation) {
    if (
      scratch !== allocation.scratch ||
      resolve(dirname(scratch)) !== resolve(scratchBase) ||
      allocation.workspace !== join(scratch, 'workspace')
    )
      throw new CheckRunUnavailable('check-run: prepared snapshot allocation is invalid');
    mkdirSync(scratch, { mode: 0o700 });
  }
  chmodSync(scratch, 0o700);
  const frozen = allocation?.workspace ?? join(scratch, 'workspace');
  let worktreeRegistered = false;
  try {
    const add = Bun.spawnSync(
      ['git', '-c', 'core.hooksPath=/dev/null', '-C', root, 'worktree', 'add', '--detach', frozen, head],
      { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000 },
    );
    if (add.exitCode !== 0)
      throw new CheckRunUnavailable(
        `check-run: candidate worktree preparation failed: ${add.stderr.toString().trim()}`,
      );
    worktreeRegistered = true;
    const selected = new Set(files);
    for (const tracked of baseFiles) if (!selected.has(tracked)) removeCandidateFile(frozen, tracked);
    for (const excluded of excludedInputs) removeCandidateFile(frozen, excluded);
    for (const file of files) {
      if (excludedInputs.some((excluded) => file === excluded || file.startsWith(`${excluded}/`))) continue;
      await copyFrozenInput(root, frozen, file);
    }
    const frozenIndex = git(frozen, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const readTree = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-C', frozen, 'read-tree', indexTree], {
      cwd: frozen,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    if (readTree.exitCode !== 0)
      throw new CheckRunUnavailable(
        `check-run: candidate index snapshot could not be prepared: ${readTree.stderr.toString().trim()}`,
      );
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
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('--env-file must contain a JSON object');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 256) throw new Error('--env-file contains too many environment values');
  const output: Record<string, string> = {};
  for (const [name, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof item !== 'string' || item.includes('\0'))
      throw new Error(`--env-file has an invalid string value for ${name}`);
    // Host-local, placement and session values never travel to the check host; they are dropped, not refused, so an
    // inherited login environment cannot make a check unavailable. Explicit --env-file may keep KERNEL_CHECK_AFFECTED;
    // Web ambient routing omits every KERNEL_CHECK_ name and does not write this exception.
    if (
      FORBIDDEN_REMOTE_ENVIRONMENT.has(name) ||
      (name.startsWith('KERNEL_CHECK_') && name !== 'KERNEL_CHECK_AFFECTED') ||
      name.startsWith('NVM_') ||
      /^npm_/i.test(name) ||
      name.startsWith('REMOTE_CHECK_') ||
      name.startsWith('REZICS_CHECK_') ||
      name.startsWith('REZICS_STACK_') ||
      name.startsWith('BUN_') ||
      name.startsWith('GOAL_') ||
      name.startsWith('CODEX_')
    )
      continue;
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
    const pathLike = name === 'GROWTH_PROFILE' || /(?:_FILE|_PATH|_DIR|_ROOT)$/.test(name);
    // A host path outside the workspace (EDITOR, nvm, debuginfod) means nothing on the check host: drop it.
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !pathLike) {
      delete relocated[name];
      continue;
    }
    relocated[name] = relative(resolve(targetWorkspace, cwd), resolve(targetWorkspace, inside)) || '.';
  }
  return relocated;
}

function preparationCommands(
  workspace: string,
  cwd: string,
  argv: readonly string[],
): NonNullable<RemoteCheck['prepare']> {
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
      throw new CheckRunUnavailable(
        `check-run: generated-input package manifest is not a bounded regular file: ${path}`,
      );
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

function parseReceiptChannel(
  env: NodeJS.ProcessEnv,
): { invocationId?: string; nonce: string; write: (line: string) => void } | undefined {
  const fd = env.REMOTE_CHECK_RECEIPT_FD;
  const nonce = env.REMOTE_CHECK_RECEIPT_NONCE;
  const invocationId = env.REMOTE_CHECK_INVOCATION_ID;
  if (fd === undefined && nonce === undefined && invocationId === undefined) return undefined;
  if (
    fd !== '3' ||
    !nonce ||
    nonce.length > 256 ||
    (invocationId !== undefined && !/^[a-f0-9]{64}$/.test(nonce)) ||
    (invocationId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId))
  )
    throw new Error('check-run: authenticated settlement needs FD 3, a 64-character nonce, and a UUID invocation id');
  return {
    ...(invocationId === undefined ? {} : { invocationId }),
    nonce,
    write: (line) => {
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(3, bytes, offset, bytes.byteLength - offset);
        if (written <= 0) throw new Error('check-run: FD 3 settlement write made no progress');
        offset += written;
      }
    },
  };
}

export function parseCheckRunArguments(argv: readonly string[]): CheckRunArguments {
  const args = [...argv];
  const result: Partial<CheckRunArguments> = { returns: [] };
  while (args[0]?.startsWith('--') && args[0] !== '--') {
    const flag = args.shift()!;
    if (flag === '--output-tree') {
      result.returns!.push(outputTreeProfile(args.shift() ?? '').transport);
      continue;
    }
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
    if (typeof result[name] !== 'string' || !result[name])
      throw new Error(`check-run requires --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
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

type ReturnedOutputResult = {
  missing: string[];
  rejected: string[];
  entries: Array<{ path: string; size: number; sha256: string; kind: 'file' | 'directory' }>;
};

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
  authenticated?: {
    manifest: RemoteReturnManifest;
    terminal: OutputTreeBinding & { exitCode: number };
    validateSource?: () => Promise<void>;
  },
): Promise<ReturnedOutputResult> {
  const result: ReturnedOutputResult = { missing: [], rejected: [], entries: [] };
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
    safeOutputTreePath(sourceRoot, stagePath);
    const stats = lstatSync(source);
    if (sensitivePath(stagePath)) throw new Error('credential or host-local data in returned output');
    if (stats.isSymbolicLink()) throw new Error('symlink in returned output');
    const destination = ensureSafeParent(stageRoot, stagePath);
    if (stats.isDirectory()) {
      mkdirSync(destination, { recursive: true, mode: stats.mode & 0o777 });
      const children = readdirSync(source).sort();
      if (children.length === 0) {
        result.entries.push({
          path: stagePath,
          size: 0,
          sha256: createHash('sha256').update('directory\0').digest('hex'),
          kind: 'directory',
        });
      }
      for (const child of children) await copyTree(join(source, child), `${stagePath}/${child}`);
      return;
    }
    if (!stats.isFile() || stats.nlink !== 1) throw new Error('special or hard-linked file in returned output');
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
    result.entries.push({ path: stagePath, size: stats.size, sha256: before, kind: 'file' });
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

  if (
    returns.includes(KERNEL_CLIENT_OUTPUT.transport) ||
    outputTreeTransportCandidates(sourceRoot, { status: 'complete', entries: result.entries }, returns).length
  ) {
    if (!authenticated)
      throw new CheckRunUnavailable('check-run: tree receiving requires authenticated terminal custody');
    await authenticated.validateSource?.();
    const order = (items: RemoteReturnManifest['entries']) =>
      items
        .map(({ path, size, sha256, kind }) => ({ path, size, sha256, kind }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    if (
      authenticated.manifest.status !== 'complete' ||
      JSON.stringify(order(authenticated.manifest.entries)) !== JSON.stringify(order(result.entries))
    )
      throw new CheckRunUnavailable('check-run: entire returned catalogue differs from physical custody');
    if (!result.missing.length && !result.rejected.length)
      receiveOutputTrees(sourceRoot, destinationRoot, authenticated.manifest, authenticated.terminal, returns);
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

type CandidateSourceManifest = NonNullable<RemoteCheck['expectedSourceManifest']>;

function identifyTransportChild(pid: number): CheckRunTransportChildIdentity | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const start = fields[19];
    if (!start || !/^\d+$/.test(start)) return null;
    return { pid, bootId, start };
  } catch {
    return null;
  }
}

function waitForTransportChildExit(child: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void child.exited.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      () => {
        clearTimeout(timeout);
        resolve(false);
      },
    );
  });
}

async function stopUnretainedTransportChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // It may have exited while its identity was being persisted.
  }
  if (await waitForTransportChildExit(child, 15_000)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // Preserve the original custody error; the invocation remains unknown.
  }
  await waitForTransportChildExit(child, 5_000);
}

function isDeclaredOutput(file: string, returns: readonly string[]): boolean {
  return outputTreeInputExclusions(returns).some((path) => file === path || file.startsWith(`${path}/`));
}

async function buildCandidateSourceManifest(
  snapshot: CandidateSnapshot,
  returns: readonly string[],
): Promise<CandidateSourceManifest> {
  const entries: CandidateSourceManifest['entries'] = [];
  for (const path of [...snapshot.inputFiles].sort()) {
    if (excludedTransferPath(path) || isDeclaredOutput(path, returns)) continue;
    const absolute = resolve(snapshot.workspace, path);
    const inside = relative(snapshot.workspace, absolute);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new CheckRunUnavailable(`check-run: source manifest path escapes the frozen workspace: ${path}`);
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const mode = stats.mode & 0o777;
    if (stats.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      assertContainedSymlink(snapshot.workspace, absolute, target);
      entries.push({
        path,
        mode,
        kind: 'link',
        sha256: createHash('sha256').update(target).digest('hex'),
        target,
      });
    } else if (stats.isFile()) {
      entries.push({ path, mode, kind: 'file', sha256: await hashFile(absolute), target: null });
    } else {
      throw new CheckRunUnavailable(`check-run: unsupported source manifest input type: ${path}`);
    }
    if (entries.length > 50_000) throw new CheckRunUnavailable('check-run: source manifest exceeds its file bound');
  }
  const deleted = gitList(snapshot.workspace, ['ls-files', '--deleted', '-z'])
    .filter((path) => !excludedTransferPath(path) && !isDeclaredOutput(path, returns))
    .sort();
  const head = git(snapshot.workspace, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const indexTree = git(snapshot.workspace, ['write-tree']);
  if (indexTree !== snapshot.indexTree)
    throw new CheckRunUnavailable('check-run: frozen candidate index changed before transfer');
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.mode}\0`);
    if (entry.kind === 'file') hash.update(`file\0${entry.sha256}\0`);
    else hash.update(`link\0${entry.target}\0`);
  }
  for (const path of deleted) hash.update(`deleted\0${path}\0`);
  hash.update(`HEAD\0${head}\0index\0${indexTree}\0`);
  const sourceSha256 = hash.digest('hex');
  if (sourceSha256 !== snapshot.sourceHash)
    throw new CheckRunUnavailable('check-run: frozen source manifest does not match its candidate fingerprint');
  const manifest: CandidateSourceManifest = { sourceSha256, head, indexTree, entries, deleted };
  if (Buffer.byteLength(JSON.stringify(manifest)) > 8 * 1024 * 1024)
    throw new CheckRunUnavailable('check-run: source manifest exceeds its byte bound');
  return manifest;
}

/** Direct placement uses the same fingerprint/catalogue algorithm as frozen check-run admission. */
export async function currentCheckSourceManifest(
  root: string,
  returns: readonly string[] = [],
): Promise<CandidateSourceManifest> {
  const inputFiles = workspaceFiles(root);
  const sourceHash = await inputFingerprint(root, inputFiles, returns);
  return buildCandidateSourceManifest(
    { workspace: root, inputFiles, sourceHash, indexTree: git(root, ['write-tree']), scratch: '' },
    returns,
  );
}

async function trustedProducerClosureHash(trustedRoot: string): Promise<string> {
  const pending = [
    resolve(import.meta.path),
    join(trustedRoot, 'scripts/check-run-settlement.ts'),
    join(trustedRoot, 'scripts/remote-check.ts'),
  ];
  const files = new Map<string, Buffer>();
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
  while (pending.length) {
    const absolute = resolve(pending.pop()!);
    if (files.has(absolute)) continue;
    const rel = relative(trustedRoot, absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new CheckRunUnavailable('check-run: trusted producer closure escapes its root');
    const stats = lstatSync(absolute);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2 * 1024 * 1024)
      throw new CheckRunUnavailable(`check-run: trusted producer source is not a bounded regular file: ${rel}`);
    const bytes = readFileSync(absolute);
    files.set(absolute, bytes);
    if (files.size > 64) throw new CheckRunUnavailable('check-run: trusted producer closure exceeds its module bound');
    const source = bytes.toString('utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[2]!;
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(absolute), specifier);
      const candidates = /\.[cm]?[jt]sx?$/.test(target)
        ? [target]
        : [target, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map((extension) => `${target}${extension}`)];
      const selected = candidates.find((candidate) => {
        try {
          const candidateStat = lstatSync(candidate);
          return candidateStat.isFile() && !candidateStat.isSymbolicLink();
        } catch {
          return false;
        }
      });
      if (!selected) throw new CheckRunUnavailable(`check-run: trusted producer import is unavailable: ${specifier}`);
      pending.push(selected);
    }
  }
  let totalBytes = 0;
  const hash = createHash('sha256');
  for (const [absolute, bytes] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    totalBytes += bytes.byteLength;
    if (totalBytes > 16 * 1024 * 1024)
      throw new CheckRunUnavailable('check-run: trusted producer closure exceeds its byte bound');
    hash.update(relative(trustedRoot, absolute).split(sep).join('/'));
    hash.update('\0');
    hash.update(createHash('sha256').update(bytes).digest('hex'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function finalPreparedInputs(evidence: RemotePreparedInputsEvidence | null): CheckRunPreparedInputs {
  if (!evidence)
    return { status: 'unavailable', sourceSha256: null, manifestSha256: null, fileCount: 0, totalBytes: 0 };
  return {
    status: 'verified',
    sourceSha256: evidence.sourceSha256,
    manifestSha256: evidence.manifestSha256,
    fileCount: evidence.fileCount,
    totalBytes: evidence.totalBytes,
  };
}

function finalReturns(
  manifest: RemoteReturnManifest | undefined,
  declarationsSha256: string,
  local: ReturnedOutputResult | undefined,
  declarations: readonly string[],
): CheckRunReturnDisposition {
  if (declarations.length === 0) return { status: 'empty', declarationsSha256, entries: [], missing: [], failures: [] };
  if (!manifest || manifest.status === 'unknown')
    return {
      status: 'unknown',
      declarationsSha256,
      entries: [],
      missing: [],
      failures: manifest?.failures ?? ['remote return manifest is unavailable'],
    };
  const entries = manifest.entries.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  const missing = [...new Set([...(manifest.missing ?? []), ...(local?.missing ?? [])])].sort();
  const failures = [...manifest.failures, ...(local?.rejected ?? [])];
  const expected = [...manifest.entries]
    .map(({ path, size, sha256, kind }) => ({ path, size, sha256, kind }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const restored = [...(local?.entries ?? [])].sort((left, right) => left.path.localeCompare(right.path));
  if (manifest.status === 'failed') failures.push('remote return inventory or copy failed');
  if (manifest.status === 'missing' && missing.length === 0) missing.push(...declarations);
  if (manifest.status !== 'complete' || JSON.stringify(expected) !== JSON.stringify(restored)) {
    if (manifest.status === 'complete' && JSON.stringify(expected) !== JSON.stringify(restored))
      failures.push('locally restored returns differ from the authenticated remote manifest');
    return {
      status: missing.length ? 'missing' : failures.length ? 'failed' : 'unknown',
      declarationsSha256,
      entries,
      missing,
      failures,
    };
  }
  return { status: 'restored', declarationsSha256, entries, missing, failures };
}

function finalCleanup(
  remote: RemoteCheckSettlement | undefined,
  source: CheckRunCleanupDisposition['source'],
  localWorktree: CheckRunCleanupDisposition['localWorktree'],
  failures: string[],
  prepared: CheckRunPreparedInputs,
  returns: CheckRunReturnDisposition,
): CheckRunCleanupDisposition {
  const remoteStatus: CheckRunCleanupDisposition['remote'] = remoteCleanupIsVerified(remote)
    ? 'verified'
    : remote?.cleanup.status === 'verified' && remote.cleanup.failures.length > 0
      ? 'failed'
      : 'unknown';
  const child = remote?.transportChildReaped ? 'reaped' : 'unknown';
  const complete =
    remoteStatus === 'verified' &&
    child === 'reaped' &&
    source === 'verified' &&
    localWorktree === 'removed' &&
    prepared.status === 'verified' &&
    (returns.status === 'empty' || returns.status === 'restored') &&
    failures.length === 0;
  return {
    disposition: complete ? 'settled' : 'unknown',
    remote: remoteStatus,
    transportChild: child,
    source,
    localWorktree,
    failures: [...new Set([...failures, ...(remote?.cleanup.failures ?? [])])].slice(0, 64),
  };
}

function remoteCleanupIsVerified(remote: RemoteCheckSettlement | undefined): boolean {
  return Boolean(
    remote &&
    remote.cleanup.schema === 1 &&
    remote.cleanup.status === 'verified' &&
    remote.cleanup.host === remote.host &&
    remote.cleanup.run === remote.run &&
    remote.cleanup.supervisorStopped === true &&
    remote.cleanup.commandGroupTerminal === true &&
    remote.cleanup.containersRemoved === true &&
    remote.cleanup.runDirectoryRemoved === true &&
    remote.cleanup.failures.length === 0,
  );
}

type PreparedCheckRunState = {
  schema: 1;
  args: CheckRunArguments;
  candidateRoot: string;
  hostsFile: string;
  hosts: Host[];
  cwd: string;
  returns: string[];
  sourceRevision: string;
  originalEnvironment: Record<string, string>;
  overlay: Record<string, string>;
  requestedPriority: 'landing' | 'critical' | null;
  frozenArgs: string[];
  preparation: NonNullable<RemoteCheck['prepare']>;
  sourceManifest: CandidateSourceManifest;
  snapshot: CandidateSnapshot;
  binding: CheckRunInvocationBinding;
};

type PreparedFinalRun = PreparedCheckRunState & {
  receiptChannel?: ReturnType<typeof parseReceiptChannel>;
};

async function prepareFinalRun(
  args: CheckRunArguments,
  processEnvironment: NodeJS.ProcessEnv,
  trustedRoot: string,
  includeReceiptChannel: boolean,
  snapshotAllocation?: { workspace: string; scratch: string },
): Promise<PreparedFinalRun> {
  const candidateRoot = absoluteDirectory(args.workspace, '--workspace');
  if (candidateRoot === trustedRoot)
    throw new CheckRunUnavailable('check-run: trusted driver root and candidate workspace must be separate');
  if (!isAbsolute(args.hosts)) throw new Error('--hosts must name an absolute JSON file');
  const hostsFile = resolve(args.hosts);
  const hostsStats = lstatSync(hostsFile);
  if (!hostsStats.isFile() || hostsStats.isSymbolicLink())
    throw new Error('--hosts must name an existing absolute regular file');
  const hostsInside = relative(candidateRoot, hostsFile);
  if (hostsInside === '' || (!hostsInside.startsWith(`..${sep}`) && hostsInside !== '..' && !isAbsolute(hostsInside)))
    throw new CheckRunUnavailable('--hosts must be outside the candidate workspace');
  const hosts: Host[] = performanceHosts(readHosts(hostsFile));
  if (hosts.length === 0) throw new CheckRunUnavailable('--hosts contains no performance-approved host');
  const cwd = candidateDirectory(candidateRoot, args.cwd, '--cwd');
  const returns = validateNonOverlappingReturns(
    args.returns.map((path) => workspaceRelative(candidateRoot, path, '--returns')),
  );
  if (
    args.command.length === 0 ||
    args.command.length > 1024 ||
    args.command.some((argument) => argument.length > 4096) ||
    Buffer.byteLength(JSON.stringify(args.command)) > 16 * 1024
  )
    throw new Error('check-run: original argv exceeds its argument bounds');
  if (!environmentCommandIsSafe(args.command))
    throw new CheckRunUnavailable('check-run: original env prefix changes remote runtime or placement authority');
  const sourceRevision = args.sourceRevision;
  const originalEnvironment = readEnvironmentFile(args.envFile, candidateRoot);
  const frozenArgs = [...args.command];
  const receiptChannel = includeReceiptChannel ? parseReceiptChannel(processEnvironment) : undefined;
  if (receiptChannel && !receiptChannel.invocationId)
    throw new Error('check-run: final settlement channel requires a caller-established invocation id');
  const requestedPriority = processEnvironment.REMOTE_CHECK_PRIORITY;
  if (requestedPriority !== undefined && requestedPriority !== 'landing' && requestedPriority !== 'critical')
    throw new CheckRunUnavailable('check-run: invalid REMOTE_CHECK_PRIORITY');
  const snapshot = await prepareCandidateSnapshot(
    candidateRoot,
    sourceRevision,
    join(trustedRoot, '.temp'),
    returns,
    snapshotAllocation,
  );
  try {
    const overlay = resolveEnvironmentFileSettings(originalEnvironment, candidateRoot, snapshot.workspace, cwd);
    const preparation = preparationCommands(snapshot.workspace, cwd, frozenArgs);
    repositoryBun(snapshot.workspace, candidateRoot);
    const sourceManifest = await buildCandidateSourceManifest(snapshot, returns);
    const hostConfigurationHash = await hashFile(hostsFile);
    const producerClosureSha256 = await trustedProducerClosureHash(trustedRoot);
    const semanticEnvironmentSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          values: Object.entries(originalEnvironment).sort(([left], [right]) => left.localeCompare(right)),
          priority: requestedPriority ?? null,
        }),
      )
      .digest('hex');
    const relocatedEnvironmentSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          values: Object.entries(overlay).sort(([left], [right]) => left.localeCompare(right)),
          priority: requestedPriority ?? null,
        }),
      )
      .digest('hex');
    const binding: CheckRunInvocationBinding = {
      sourceRevision,
      indexTree: snapshot.indexTree,
      sourceSha256: snapshot.sourceHash,
      argvSha256: createHash('sha256').update(JSON.stringify(frozenArgs)).digest('hex'),
      cwd,
      semanticEnvironmentSha256,
      relocatedEnvironmentSha256,
      producerClosureSha256,
      hostsSha256: hostConfigurationHash,
      preparationCommandsSha256: createHash('sha256').update(JSON.stringify(preparation)).digest('hex'),
      returnsSha256: createHash('sha256').update(JSON.stringify(returns)).digest('hex'),
    };
    return {
      schema: 1,
      args: { ...args, hosts: hostsFile, workspace: candidateRoot, returns: [...args.returns], command: frozenArgs },
      candidateRoot,
      hostsFile,
      hosts,
      cwd,
      returns,
      sourceRevision,
      originalEnvironment,
      overlay,
      requestedPriority: requestedPriority ?? null,
      frozenArgs,
      preparation,
      sourceManifest,
      snapshot,
      binding,
      ...(receiptChannel === undefined ? {} : { receiptChannel }),
    };
  } catch (error) {
    try {
      cleanupWorktree(candidateRoot, snapshot.workspace, snapshot.scratch);
    } catch (cleanupError) {
      process.stderr.write(
        `check-run: prepared snapshot cleanup failed; retaining workspace=${snapshot.workspace} source-sha256=${snapshot.sourceHash}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
      );
    }
    throw error;
  }
}

async function runCheckLegacy(
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
  if (hosts.length === 0) throw new CheckRunUnavailable('--hosts contains no performance-approved host');
  const cwd = candidateDirectory(candidateRoot, args.cwd, '--cwd');
  const returns = validateNonOverlappingReturns(
    args.returns.map((path) => workspaceRelative(candidateRoot, path, '--returns')),
  );
  if (
    args.command.length === 0 ||
    args.command.length > 1024 ||
    args.command.some((argument) => argument.length > 4096)
  )
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
  let legacySettlement: RemoteCheckSettlement | undefined;
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
    const runtime = repositoryBun(snapshot.workspace, candidateRoot);
    const producerSourceHash = await hashFile(resolve(import.meta.path));
    const hostConfigurationHash = await hashFile(hostsFile);
    const preparationHash = createHash('sha256')
      .update(JSON.stringify(preparation ?? []))
      .digest('hex');
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
      allowedHosts: hosts.map(({ name }) => name),
      hostsFile,
      workspace: snapshot.workspace,
      cwd,
      command: ['env', ...Object.entries(overlay).map(([name, value]) => `${name}=${value}`), ...frozenArgs],
      returns,
      runtimeProducer: candidateRoot,
      runtime,
      ...(preparation.length === 0 ? {} : { prepare: preparation }),
      expectedSourceSha256: snapshot.sourceHash,
      expectedSourceManifest: await buildCandidateSourceManifest(snapshot, returns),
      settled: (settlement) => {
        legacySettlement = settlement;
      },
      ...(cancellation === undefined ? {} : { cancellation }),
      ...(requestedPriority === undefined ? {} : { priority: requestedPriority }),
      started: (host) => {
        if (signal.aborted || executionCancellation(cancellation))
          throw new Aborted('check-run: cancelled command cannot start');
        if (!isAdmittedCheckRunHost(host, hosts))
          throw new CheckRunUnavailable(`check-run: remote transport selected forbidden host ${host}`);
        dependencies.onStarted?.(host);
      },
      completed: (receipt) => {
        const parsed = parseRemotePhysicalRunReceipt(receipt);
        if (!parsed || !isAdmittedCheckRunHost(parsed.host, hosts))
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
          legacySettlement?.native?.run === receivedReceipt.run &&
            legacySettlement.native.host === receivedReceipt.host &&
            legacySettlement.native.exitCode === receivedReceipt.exitCode &&
            legacySettlement.preparedInputs?.sourceSha256 === snapshot.sourceHash
            ? {
                manifest: legacySettlement.returns,
                terminal: {
                  host: receivedReceipt.host,
                  run: receivedReceipt.run,
                  sourceSha256: snapshot.sourceHash,
                  exitCode: receivedReceipt.exitCode,
                },
                validateSource: async () => {
                  if (
                    (await inputFingerprint(candidateRoot, workspaceFiles(candidateRoot), returns)) !==
                      snapshot.sourceHash ||
                    (await inputFingerprint(snapshot.workspace, snapshot.inputFiles, returns)) !== snapshot.sourceHash
                  )
                    throw new CheckRunUnavailable('check-run: source changed before tree receiving');
                },
              }
            : undefined,
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
        process.stderr.write(
          `check-run: frozen source cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        if (outcome === 0) outcome = 1;
      }
    } else {
      process.stderr.write(
        `check-run: remote physical terminality is unknown; retaining frozen workspace=${snapshot.workspace} source-sha256=${snapshot.sourceHash}\n`,
      );
      try {
        dependencies.onRetainSnapshot?.(snapshot);
      } catch (error) {
        process.stderr.write(
          `check-run: retained snapshot observer failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
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

export async function runCheck(
  args: CheckRunArguments,
  dependencies: CheckRunDependencies = {},
  signal = new AbortController().signal,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const needsFinalProtocol =
    dependencies.transport === undefined ||
    dependencies.settlementWriter !== undefined ||
    processEnvironment.REMOTE_CHECK_INVOCATION_ID !== undefined;
  if (!needsFinalProtocol) return runCheckLegacy(args, dependencies, signal, processEnvironment);
  return runCheckWithFinalSettlement(args, dependencies, signal, processEnvironment);
}

async function runCheckWithFinalSettlement(
  args: CheckRunArguments,
  dependencies: CheckRunDependencies,
  signal: AbortSignal,
  processEnvironment: NodeJS.ProcessEnv,
  claimedPrepared?: { context: PreparedFinalRun; record: CheckRunInvocationRecord },
): Promise<number> {
  const trustedRoot = resolve(import.meta.dir, '..');
  if (signal.aborted && !claimedPrepared) return 130;
  const prepared = claimedPrepared?.context ?? (await prepareFinalRun(args, processEnvironment, trustedRoot, true));
  const {
    candidateRoot,
    hostsFile,
    hosts,
    cwd,
    returns,
    overlay,
    requestedPriority,
    frozenArgs,
    preparation,
    sourceManifest,
    snapshot,
    binding,
  } = prepared;
  const receiptChannel = prepared.receiptChannel;
  const stateOptions: CheckRunStateOptions = dependencies.stateDirectory
    ? { stateDirectory: dependencies.stateDirectory }
    : {};
  let registration: Awaited<ReturnType<typeof registerCheckRunInvocation>> | undefined = claimedPrepared
    ? {
        invocationId: claimedPrepared.record.invocationId,
        nonce: claimedPrepared.record.nonce,
        binding: claimedPrepared.record.binding,
        cancellation: readCheckRunCancellation(claimedPrepared.record.invocationId, stateOptions),
      }
    : undefined;
  let snapshotBound = false;
  let receivedReceipt: RemotePhysicalRunReceipt | undefined;
  let allocatedPhysical: { host: string; run: string } | undefined;
  let receivedPhysical: { host: string; run: string } | undefined;
  let remoteSettlement: RemoteCheckSettlement | undefined;
  let nativeReceiptPromise: Promise<void> | undefined;
  let remoteSettlementPromise: Promise<void> | undefined;
  let runFailure: unknown;
  let returnFailure: unknown;
  let cleanupFailure: unknown;
  let receiptForwardFailure: unknown;
  let localReturns: ReturnedOutputResult | undefined;
  let sourceState: CheckRunCleanupDisposition['source'] = 'unknown';
  let localWorktree: CheckRunCleanupDisposition['localWorktree'] = 'retained';
  let outcome = REMOTE_TRANSPORT_FAILURE;
  let transportStarted = false;
  let finalRecord: CheckRunInvocationRecord | undefined;
  let cancellationPromise: Promise<void> | undefined;

  const onAbort = () => {
    if (!registration) return;
    cancellationPromise = cancelCheckRunInvocation(registration.invocationId, registration.nonce, 15, stateOptions)
      .then(() => undefined)
      .catch((error) => {
        runFailure ??= error;
      });
  };

  try {
    const callerInvocationId = receiptChannel?.invocationId;
    if (claimedPrepared) {
      if (
        claimedPrepared.record.phase !== 'claimed' ||
        !receiptChannel?.invocationId ||
        receiptChannel.invocationId !== claimedPrepared.record.invocationId ||
        receiptChannel.nonce !== claimedPrepared.record.nonce ||
        checkRunBindingHash(claimedPrepared.record.binding) !== checkRunBindingHash(binding)
      )
        throw new CheckRunUnavailable(
          'check-run: prepared descriptor differs from the caller-established FD3 identity',
        );
    } else if (callerInvocationId) {
      const record = await getCheckRunStatus(callerInvocationId, stateOptions);
      if (record.nonce !== receiptChannel?.nonce)
        throw new CheckRunUnavailable('check-run: caller invocation nonce does not match private producer state');
      if (checkRunBindingHash(record.binding) !== checkRunBindingHash(binding))
        throw new CheckRunUnavailable('check-run: caller invocation binding does not match this candidate and command');
      registration = {
        invocationId: record.invocationId,
        nonce: record.nonce,
        binding: record.binding,
        cancellation: readCheckRunCancellation(record.invocationId, stateOptions),
      };
      if (record.final) {
        cleanupWorktree(candidateRoot, snapshot.workspace, snapshot.scratch);
        snapshotBound = true;
        const nativeExitCode = record.final.native?.exitCode;
        if (nativeExitCode !== undefined && nativeExitCode !== 0) return nativeExitCode;
        return record.finalCustody?.aggregate === 'settled' ? 0 : REMOTE_TRANSPORT_FAILURE;
      }
      if (record.phase !== 'registered') {
        cleanupWorktree(candidateRoot, snapshot.workspace, snapshot.scratch);
        snapshotBound = true;
        return record.native?.exitCode && record.native.exitCode !== 0
          ? record.native.exitCode
          : REMOTE_TRANSPORT_FAILURE;
      }
    } else {
      registration = await registerCheckRunInvocation(binding, {
        ...stateOptions,
        candidateWorkspace: candidateRoot,
      });
    }
    const establishedRegistration = registration;
    if (!establishedRegistration)
      throw new CheckRunUnavailable('check-run: invocation could not be registered before workspace admission');
    const cancellationIsRequested = () =>
      signal.aborted || readCheckRunCancellation(establishedRegistration.invocationId, stateOptions).requested;
    const cancellationWon = () => {
      try {
        return cancellationIsRequested();
      } catch {
        return signal.aborted;
      }
    };
    dependencies.onDurableCancellationReady?.((cancellationSignal) =>
      cancelCheckRunInvocation(
        establishedRegistration.invocationId,
        establishedRegistration.nonce,
        cancellationSignal,
        stateOptions,
      ).then(() => undefined),
    );
    if (signal.aborted) {
      await cancelCheckRunInvocation(
        establishedRegistration.invocationId,
        establishedRegistration.nonce,
        15,
        stateOptions,
      );
      if (claimedPrepared) {
        await reconcileCheckRunInvocation(establishedRegistration.invocationId, { ...stateOptions, force: true });
        cleanupWorktree(candidateRoot, snapshot.workspace, snapshot.scratch);
        await markCheckRunPreparedSnapshotCustody(
          establishedRegistration.invocationId,
          establishedRegistration.nonce,
          'removed',
          stateOptions,
        );
      } else {
        cleanupWorktree(candidateRoot, snapshot.workspace, snapshot.scratch);
      }
      snapshotBound = true;
      return 130;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await bindCheckRunWorkspace(
        establishedRegistration.invocationId,
        establishedRegistration.nonce,
        candidateRoot,
        {
          workspace: snapshot.workspace,
          scratch: snapshot.scratch,
          sourceSha256: snapshot.sourceHash,
          inputFiles: snapshot.inputFiles,
        },
        returns,
        stateOptions,
      );
    } catch (error) {
      if (cancellationWon()) throw new Aborted('check-run: cancelled invocation cannot bind its workspace');
      throw error;
    }
    snapshotBound = true;
    const runtime = repositoryBun(snapshot.workspace, candidateRoot);
    // This fsynced transition is the admission linearization point. A cancellation that wins
    // while the record is queued prevents host probing and any later run identity allocation.
    try {
      await beginCheckRunAllocation(establishedRegistration.invocationId, establishedRegistration.nonce, stateOptions);
    } catch (error) {
      if (cancellationWon()) throw new Aborted('check-run: cancelled invocation cannot enter remote admission');
      throw error;
    }
    if (cancellationIsRequested()) throw new Aborted('check-run: cancelled invocation cannot enter remote admission');

    const remoteOptions: RemoteCheck = {
      hosts,
      allowedHosts: hosts.map(({ name }) => name),
      hostsFile,
      workspace: snapshot.workspace,
      cwd,
      command: ['env', ...Object.entries(overlay).map(([name, value]) => `${name}=${value}`), ...frozenArgs],
      returns,
      runtimeProducer: candidateRoot,
      runtime,
      ...(preparation.length === 0 ? {} : { prepare: preparation }),
      cancellation: establishedRegistration.cancellation,
      ...(requestedPriority == null ? {} : { priority: requestedPriority }),
      expectedSourceSha256: snapshot.sourceHash,
      expectedSourceManifest: sourceManifest,
      maxTransportAttempts: 1,
      allocated: async ({ host, run }) => {
        if (!isAdmittedCheckRunHost(host, hosts))
          throw new CheckRunUnavailable(`check-run: remote transport selected forbidden host ${host}`);
        const admitted = { host, run };
        await allocateCheckRunPhysical(
          establishedRegistration.invocationId,
          establishedRegistration.nonce,
          host,
          run,
          stateOptions,
        );
        allocatedPhysical = admitted;
      },
      spawnWithCustody: async (physical, spawn) => {
        let child: ReturnType<typeof Bun.spawn> | undefined;
        try {
          return await withCheckRunSpawnPermit(
            establishedRegistration.invocationId,
            establishedRegistration.nonce,
            physical.host,
            physical.run,
            () => {
              const spawned = spawn();
              child = spawned;
              return spawned;
            },
            stateOptions,
            (spawned) => identifyTransportChild(spawned.pid),
          );
        } catch (error) {
          if (child) await stopUnretainedTransportChild(child);
          throw error;
        }
      },
      started: (host) => {
        if (signal.aborted) throw new Aborted('check-run: cancelled command cannot start');
        if (!isAdmittedCheckRunHost(host, hosts))
          throw new CheckRunUnavailable(`check-run: remote transport selected forbidden host ${host}`);
        dependencies.onStarted?.(host);
      },
      completed: (receipt) => {
        nativeReceiptPromise = (async () => {
          const parsed = parseRemotePhysicalRunReceipt(receipt);
          if (!parsed || !isAdmittedCheckRunHost(parsed.host, hosts))
            throw new CheckRunUnavailable(
              'check-run: remote native terminal receipt is invalid or names a forbidden host',
            );
          const admitted = allocatedPhysical;
          if (!admitted)
            throw new CheckRunUnavailable('check-run: native terminal receipt has no admitted physical identity');
          if (admitted.host !== parsed.host || admitted.run !== parsed.run)
            throw new CheckRunUnavailable('check-run: native receipt does not match the admitted physical identity');
          receivedPhysical = admitted;
          receivedReceipt = parsed;
          const digest = checkRunNativeReceiptDigest(parsed);
          await markCheckRunNativeTerminal(
            establishedRegistration.invocationId,
            establishedRegistration.nonce,
            {
              host: parsed.host,
              run: parsed.run,
              exitCode: parsed.exitCode,
              lifetimeFailure: parsed.lifetimeFailure !== null,
              receiptSha256: digest,
            },
            stateOptions,
          );
          const message = createCheckRunNativeTerminalMessage({
            invocationId: establishedRegistration.invocationId,
            nonce: establishedRegistration.nonce,
            binding,
            physical: { host: parsed.host, run: parsed.run },
            receipt: parsed,
          });
          const nativeWriter =
            dependencies.receiptWriter ?? (receiptChannel?.invocationId ? receiptChannel.write : undefined);
          if (nativeWriter) {
            try {
              nativeWriter(`${JSON.stringify(message)}\n`);
            } catch (error) {
              receiptForwardFailure = error;
            }
          }
        })().catch((error) => {
          runFailure ??= error;
        });
        return nativeReceiptPromise;
      },
      settled: (settlement) => {
        remoteSettlementPromise = Promise.resolve()
          .then(() => {
            const admitted = allocatedPhysical;
            if (!admitted || settlement.host !== admitted.host || settlement.run !== admitted.run)
              throw new CheckRunUnavailable(
                'check-run: remote final evidence does not match the admitted physical identity',
              );
            remoteSettlement = settlement;
          })
          .catch((error) => {
            runFailure ??= error;
          });
        return remoteSettlementPromise;
      },
    };

    const transport = dependencies.transport ?? remoteCheck;
    transportStarted = true;
    try {
      outcome = await transport(remoteOptions, signal);
    } catch (error) {
      runFailure = error;
    }
    await nativeReceiptPromise;
    await remoteSettlementPromise;
    if (receivedReceipt) outcome = receivedReceipt.exitCode;
    else if (signal.aborted) outcome = 128 + 2;
  } catch (error) {
    runFailure ??= error;
    if (error instanceof Aborted) outcome = 128 + 2;
    else if (error instanceof CheckRunUnavailable) outcome = error.exitCode;
    else outcome = REMOTE_TRANSPORT_FAILURE;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await cancellationPromise;
  }

  if (!registration) {
    if (!snapshotBound) {
      try {
        cleanupWorktree(candidateRoot, snapshot.workspace, snapshot.scratch);
      } catch (error) {
        cleanupFailure = error;
        dependencies.onRetainSnapshot?.(snapshot);
      }
    }
    throw runFailure ?? new CheckRunUnavailable('check-run: invocation could not be registered');
  }

  if (!receivedReceipt || !receivedPhysical) {
    if (receivedReceipt && !receivedPhysical) {
      runFailure ??= new CheckRunUnavailable('check-run: native terminal receipt lost its admitted physical identity');
      outcome = REMOTE_TRANSPORT_FAILURE;
    } else if (outcome === 0) {
      outcome = REMOTE_TRANSPORT_FAILURE;
    }
    const reason = runFailure instanceof Error ? runFailure.message : 'native terminal receipt is unavailable';
    try {
      await setCheckRunUnknown(registration.invocationId, registration.nonce, reason, stateOptions);
    } catch (error) {
      runFailure ??= error;
    }
    if (transportStarted) {
      process.stderr.write(
        `check-run: physical terminality or cleanup is unknown; retaining frozen workspace=${snapshot.workspace} source-sha256=${snapshot.sourceHash}\n`,
      );
      try {
        dependencies.onRetainSnapshot?.(snapshot);
      } catch (error) {
        process.stderr.write(
          `check-run: retained snapshot observer failed: ${error instanceof Error ? error.message : error}\n`,
        );
      }
    } else {
      try {
        if (
          claimedPrepared &&
          (signal.aborted || readCheckRunCancellation(registration.invocationId, stateOptions).requested)
        )
          await reconcileCheckRunInvocation(registration.invocationId, {
            ...stateOptions,
            force: true,
          });
        cleanupWorktree(candidateRoot, snapshot.workspace, snapshot.scratch);
        if (claimedPrepared)
          await markCheckRunPreparedSnapshotCustody(
            registration.invocationId,
            registration.nonce,
            'removed',
            stateOptions,
          );
      } catch (error) {
        cleanupFailure = error;
        dependencies.onRetainSnapshot?.(snapshot);
        if (claimedPrepared)
          await markCheckRunPreparedSnapshotCustody(
            registration.invocationId,
            registration.nonce,
            'unknown',
            stateOptions,
          ).catch(() => undefined);
      }
    }
    if (runFailure) process.stderr.write(`${runFailure instanceof Error ? runFailure.message : String(runFailure)}\n`);
    return outcome;
  }

  if (!remoteSettlement) {
    remoteSettlement = {
      schema: 1,
      host: receivedReceipt.host,
      run: receivedReceipt.run,
      native: receivedReceipt,
      preparedInputs: null,
      returns: {
        schema: 1,
        status: 'unknown',
        entries: [],
        missing: [],
        failures: ['remote return and cleanup settlement is unavailable'],
      },
      cleanup: {
        schema: 1,
        host: receivedReceipt.host,
        run: receivedReceipt.run,
        status: 'unknown',
        supervisorStopped: false,
        commandGroupTerminal: false,
        containersRemoved: false,
        runDirectoryRemoved: false,
        failures: ['remote cleanup settlement is unavailable'],
      },
      transportChildReaped: false,
    };
  }

  const physical = receivedPhysical;
  if (
    remoteSettlement.host !== physical.host ||
    remoteSettlement.run !== physical.run ||
    remoteSettlement.native?.host !== physical.host ||
    remoteSettlement.native?.run !== physical.run ||
    remoteSettlement.native.exitCode !== receivedReceipt.exitCode
  ) {
    runFailure ??= new CheckRunUnavailable('check-run: remote settlement and native terminal identity differ');
    remoteSettlement = {
      ...remoteSettlement,
      cleanup: {
        ...remoteSettlement.cleanup,
        status: 'unknown',
        failures: [...remoteSettlement.cleanup.failures, 'native settlement identity mismatch'],
      },
    };
  }

  const preparedInputs = finalPreparedInputs(remoteSettlement.preparedInputs);
  if (preparedInputs.status !== 'verified' || preparedInputs.sourceSha256 !== snapshot.sourceHash) {
    runFailure ??= new CheckRunUnavailable(
      'check-run: remote prepared source/generated input evidence is unavailable or mismatched',
    );
  }
  try {
    clearDeclaredArtifacts(candidateRoot, returns);
    localReturns = await copyReturnedOutputs(
      snapshot.workspace,
      candidateRoot,
      join(snapshot.scratch, 'returns'),
      receivedReceipt.run,
      returns,
      {
        manifest: remoteSettlement.returns,
        terminal: {
          host: receivedReceipt.host,
          run: receivedReceipt.run,
          sourceSha256: snapshot.sourceHash,
          exitCode: receivedReceipt.exitCode,
        },
        validateSource: async () => {
          if (
            preparedInputs.status !== 'verified' ||
            preparedInputs.sourceSha256 !== snapshot.sourceHash ||
            runFailure ||
            (await inputFingerprint(candidateRoot, workspaceFiles(candidateRoot), returns)) !== snapshot.sourceHash ||
            (await inputFingerprint(snapshot.workspace, snapshot.inputFiles, returns)) !== snapshot.sourceHash
          )
            throw new CheckRunUnavailable('check-run: source or physical custody changed before publication');
        },
      },
    );
  } catch (error) {
    returnFailure = error;
  }
  const returnDisposition = finalReturns(
    remoteSettlement.returns,
    registration.binding.returnsSha256,
    localReturns,
    returns,
  );
  if (returnDisposition.status !== 'empty' && returnDisposition.status !== 'restored') {
    returnFailure ??= new CheckRunUnavailable('check-run: declared output return or restoration is incomplete');
  }
  if (receiptForwardFailure) {
    runFailure ??= new CheckRunUnavailable(
      `check-run: authenticated native receipt could not be forwarded: ${receiptForwardFailure instanceof Error ? receiptForwardFailure.message : String(receiptForwardFailure)}`,
    );
  }

  try {
    const frozenFingerprint = await inputFingerprint(snapshot.workspace, snapshot.inputFiles, returns);
    const candidateFingerprint = await inputFingerprint(candidateRoot, workspaceFiles(candidateRoot), returns);
    if (frozenFingerprint !== snapshot.sourceHash || candidateFingerprint !== snapshot.sourceHash) {
      sourceState = 'changed';
      runFailure ??= new CheckRunUnavailable(
        'check-run: candidate or frozen source changed while the remote run was active',
      );
    } else sourceState = 'verified';
  } catch (error) {
    sourceState = 'unknown';
    runFailure ??= error;
  }

  const remoteCleanupComplete =
    remoteCleanupIsVerified(remoteSettlement) && remoteSettlement.transportChildReaped === true;
  const returnComplete = returnDisposition.status === 'empty' || returnDisposition.status === 'restored';
  const localCleanupAllowed =
    remoteCleanupComplete &&
    preparedInputs.status === 'verified' &&
    sourceState === 'verified' &&
    returnComplete &&
    runFailure === undefined &&
    returnFailure === undefined &&
    receiptForwardFailure === undefined;
  if (localCleanupAllowed) {
    try {
      (dependencies.cleanupWorktree ?? cleanupWorktree)(candidateRoot, snapshot.workspace, snapshot.scratch);
      if (existsSync(snapshot.workspace) || existsSync(snapshot.scratch))
        throw new CheckRunUnavailable('check-run: frozen worktree cleanup returned before removal was verified');
      localWorktree = 'removed';
    } catch (error) {
      cleanupFailure = error;
      localWorktree = existsSync(snapshot.workspace) ? 'retained' : 'unknown';
      process.stderr.write(
        `check-run: frozen source cleanup failed: ${error instanceof Error ? error.message : error}\n`,
      );
    }
  }
  if (localWorktree !== 'removed') {
    try {
      dependencies.onRetainSnapshot?.(snapshot);
    } catch (error) {
      process.stderr.write(
        `check-run: retained snapshot observer failed: ${error instanceof Error ? error.message : error}\n`,
      );
    }
  }

  const cleanupFailures = [
    ...(cleanupFailure ? [cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)] : []),
    ...(receiptForwardFailure
      ? [
          `native terminal FD 3 write failed: ${receiptForwardFailure instanceof Error ? receiptForwardFailure.message : String(receiptForwardFailure)}`,
        ]
      : []),
    ...(remoteSettlement.cleanup.failures ?? []),
  ].map((failure) => failure.slice(0, 512));
  if (!remoteCleanupComplete && cleanupFailures.length === 0)
    cleanupFailures.push('remote cleanup or transport child terminality is unknown');
  const cleanupDisposition = finalCleanup(
    remoteSettlement,
    sourceState,
    localWorktree,
    cleanupFailures,
    preparedInputs,
    returnDisposition,
  );
  const primaryFailures = [
    ...(runFailure ? [runFailure instanceof Error ? runFailure.message : String(runFailure)] : []),
    ...(returnFailure ? [returnFailure instanceof Error ? returnFailure.message : String(returnFailure)] : []),
  ].map((failure) => failure.slice(0, 512));
  let finalMessage: CheckRunFinalSettlement | undefined;
  try {
    finalMessage = createCheckRunFinalSettlement({
      invocationId: registration.invocationId,
      nonce: registration.nonce,
      binding: registration.binding,
      physical,
      native: {
        exitCode: receivedReceipt.exitCode,
        lifetimeFailure: receivedReceipt.lifetimeFailure !== null,
        receiptSha256: checkRunNativeReceiptDigest(receivedReceipt),
      },
      preparedInputs,
      returns: returnDisposition,
      cleanup: cleanupDisposition,
      failures: { primary: primaryFailures.slice(0, 64), cleanup: cleanupFailures.slice(0, 64) },
    });
  } catch (error) {
    runFailure ??= error;
  }
  if (finalMessage) {
    const encoded = `${encodeCheckRunFinalSettlement(finalMessage)}\n`;
    const writer = dependencies.settlementWriter ?? (receiptChannel?.invocationId ? receiptChannel.write : undefined);
    try {
      finalRecord = await stageCheckRunFinalSettlement(encoded, stateOptions);
      const deliverySha256 = finalRecord.finalCustody!.deliverySha256;
      writer?.(encoded);
      finalRecord = await markCheckRunFinalSettlementDelivery(
        registration.invocationId,
        deliverySha256,
        writer ? 'delivered' : 'not-required',
        stateOptions,
      );
    } catch (error) {
      runFailure ??= error;
      if (finalRecord?.final && finalRecord.finalCustody?.delivery === 'pending') {
        try {
          finalRecord = await markCheckRunFinalSettlementDelivery(
            registration.invocationId,
            finalRecord.finalCustody.deliverySha256,
            'unknown',
            stateOptions,
          );
        } catch {
          // The durable pending record pins the exact original final and prevents a contradictory replay.
        }
      } else {
        try {
          await setCheckRunUnknown(
            registration.invocationId,
            registration.nonce,
            `final settlement could not be accepted or forwarded: ${error instanceof Error ? error.message.slice(0, 400) : 'unknown error'}`,
            stateOptions,
          );
        } catch {
          // The retained phase remains conservative if even the private state update fails.
        }
      }
    }
  } else {
    try {
      await setCheckRunUnknown(
        registration.invocationId,
        registration.nonce,
        `final settlement could not be constructed: ${runFailure instanceof Error ? runFailure.message.slice(0, 400) : 'unknown failure'}`,
        stateOptions,
      );
    } catch {
      // Preserve the exact earlier failure; the consumer must keep custody.
    }
  }

  if (runFailure) process.stderr.write(`${runFailure instanceof Error ? runFailure.message : String(runFailure)}\n`);
  if (returnFailure)
    process.stderr.write(`${returnFailure instanceof Error ? returnFailure.message : String(returnFailure)}\n`);
  if (finalRecord?.final?.native && finalRecord.final.native.exitCode !== 0) return finalRecord.final.native.exitCode;
  if (receivedReceipt.exitCode !== 0) return receivedReceipt.exitCode;
  if (
    !finalRecord?.final ||
    finalRecord.final.cleanup.disposition !== 'settled' ||
    !finalRecord.finalCustody ||
    finalRecord.finalCustody.aggregate !== 'settled'
  )
    return REMOTE_TRANSPORT_FAILURE;
  return 0;
}

function preparedStateFromUnknown(value: unknown, record: CheckRunInvocationRecord): PreparedCheckRunState {
  const keys = [
    'schema',
    'args',
    'candidateRoot',
    'hostsFile',
    'hosts',
    'cwd',
    'returns',
    'sourceRevision',
    'originalEnvironment',
    'overlay',
    'requestedPriority',
    'frozenArgs',
    'preparation',
    'sourceManifest',
    'snapshot',
    'binding',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new CheckRunUnavailable('check-run: durable prepared execution has an invalid shape');
  const state = value as PreparedCheckRunState;
  const hashJson = (value: unknown) => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new CheckRunUnavailable('check-run: durable prepared execution is not serializable');
    return createHash('sha256').update(encoded).digest('hex');
  };
  const hashEnvironment = (values: Record<string, string>) =>
    hashJson({
      values: Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
      priority: state.requestedPriority,
    });
  const isStringRecord = (item: unknown): item is Record<string, string> =>
    Boolean(
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      Object.values(item).every((entry) => typeof entry === 'string'),
    );
  if (
    state.schema !== 1 ||
    !record.snapshot ||
    !record.candidateWorkspace ||
    !record.descriptor ||
    !record.preparedExecution ||
    resolve(state.candidateRoot) !== record.candidateWorkspace ||
    resolve(state.snapshot.workspace) !== record.snapshot.workspace ||
    resolve(state.snapshot.scratch) !== record.snapshot.scratch ||
    state.snapshot.sourceHash !== record.snapshot.sourceSha256 ||
    JSON.stringify([...state.snapshot.inputFiles].sort()) !== JSON.stringify([...record.snapshot.inputFiles].sort()) ||
    checkRunBindingHash(state.binding) !== checkRunBindingHash(record.binding) ||
    state.sourceManifest.sourceSha256 !== record.binding.sourceSha256 ||
    state.sourceManifest.head !== record.binding.sourceRevision ||
    state.sourceManifest.indexTree !== record.binding.indexTree ||
    state.snapshot.indexTree !== record.binding.indexTree ||
    state.sourceRevision !== record.binding.sourceRevision ||
    state.cwd !== record.binding.cwd ||
    !Array.isArray(state.frozenArgs) ||
    !Array.isArray(state.returns) ||
    !Array.isArray(state.hosts) ||
    !Array.isArray(state.preparation) ||
    !isStringRecord(state.originalEnvironment) ||
    !isStringRecord(state.overlay) ||
    hashJson(state.frozenArgs) !== record.binding.argvSha256 ||
    hashJson(state.preparation) !== record.binding.preparationCommandsSha256 ||
    hashJson(state.returns) !== record.binding.returnsSha256 ||
    hashEnvironment(state.originalEnvironment) !== record.binding.semanticEnvironmentSha256 ||
    hashEnvironment(state.overlay) !== record.binding.relocatedEnvironmentSha256
  )
    throw new CheckRunUnavailable('check-run: durable prepared execution differs from its registered binding');
  if (
    state.requestedPriority !== null &&
    state.requestedPriority !== 'landing' &&
    state.requestedPriority !== 'critical'
  )
    throw new CheckRunUnavailable('check-run: durable prepared priority is invalid');
  if (
    !state.args ||
    state.args.workspace !== state.candidateRoot ||
    state.args.hosts !== state.hostsFile ||
    state.args.sourceRevision !== state.sourceRevision ||
    JSON.stringify(state.args.command) !== JSON.stringify(state.frozenArgs) ||
    JSON.stringify(state.returns) !==
      JSON.stringify(state.args.returns.map((path) => workspaceRelative(state.candidateRoot, path, '--returns')))
  )
    throw new CheckRunUnavailable('check-run: durable prepared arguments differ from their binding');
  return state;
}

async function validatePreparedAuthorities(
  state: PreparedCheckRunState,
  record: CheckRunInvocationRecord,
  processEnvironment: NodeJS.ProcessEnv,
): Promise<PreparedFinalRun> {
  const trustedRoot = resolve(import.meta.dir, '..');
  const currentPriority = processEnvironment.REMOTE_CHECK_PRIORITY ?? null;
  if (currentPriority !== state.requestedPriority)
    throw new CheckRunUnavailable('check-run: remote priority changed after preparation');
  if (
    !isAbsolute(state.hostsFile) ||
    !isAbsolute(state.args.envFile) ||
    state.candidateRoot === trustedRoot ||
    !record.snapshot ||
    !record.candidateWorkspace
  )
    throw new CheckRunUnavailable('check-run: prepared execution authority is incomplete');
  const hostsStats = lstatSync(state.hostsFile);
  if (!hostsStats.isFile() || hostsStats.isSymbolicLink())
    throw new CheckRunUnavailable('check-run: prepared host configuration is no longer a regular file');
  const hostsInside = relative(state.candidateRoot, state.hostsFile);
  if (hostsInside === '' || (!hostsInside.startsWith(`..${sep}`) && hostsInside !== '..' && !isAbsolute(hostsInside)))
    throw new CheckRunUnavailable('check-run: prepared hosts file moved inside the candidate workspace');
  const currentHosts = performanceHosts(readHosts(state.hostsFile));
  if (currentHosts.length === 0) throw new CheckRunUnavailable('check-run: prepared host pool is no longer available');
  const [hostsHash, closureHash, currentFingerprint, frozenFingerprint] = await Promise.all([
    hashFile(state.hostsFile),
    trustedProducerClosureHash(trustedRoot),
    inputFingerprint(state.candidateRoot, workspaceFiles(state.candidateRoot), state.returns),
    inputFingerprint(state.snapshot.workspace, state.snapshot.inputFiles, state.returns),
  ]);
  if (hostsHash !== record.binding.hostsSha256)
    throw new CheckRunUnavailable('check-run: host configuration changed after preparation');
  if (closureHash !== record.binding.producerClosureSha256)
    throw new CheckRunUnavailable('check-run: trusted producer closure changed after preparation');
  if (currentFingerprint !== record.binding.sourceSha256 || frozenFingerprint !== record.binding.sourceSha256)
    throw new CheckRunUnavailable('check-run: candidate or frozen input changed after preparation');
  const currentEnvironment = readEnvironmentFile(state.args.envFile, state.candidateRoot);
  const semanticEnvironmentSha256 = createHash('sha256')
    .update(
      JSON.stringify({
        values: Object.entries(currentEnvironment).sort(([left], [right]) => left.localeCompare(right)),
        priority: currentPriority,
      }),
    )
    .digest('hex');
  if (semanticEnvironmentSha256 !== record.binding.semanticEnvironmentSha256)
    throw new CheckRunUnavailable('check-run: private environment input changed after preparation');
  const cwd = candidateDirectory(state.candidateRoot, state.cwd, '--cwd');
  if (cwd !== state.cwd) throw new CheckRunUnavailable('check-run: prepared working directory changed');
  return {
    ...state,
    hosts: currentHosts,
    receiptChannel: parseReceiptChannel(processEnvironment),
  };
}

async function abandonClaimedPreparedInvocation(
  record: CheckRunInvocationRecord,
  stateOptions: CheckRunStateOptions,
): Promise<void> {
  try {
    await cancelCheckRunInvocation(record.invocationId, record.nonce, 15, stateOptions);
    const reconciled = await reconcileCheckRunInvocation(record.invocationId, { ...stateOptions, force: true });
    if (
      !reconciled.physical &&
      reconciled.phase === 'cancelled' &&
      reconciled.snapshot &&
      reconciled.candidateWorkspace
    ) {
      cleanupWorktree(reconciled.candidateWorkspace, reconciled.snapshot.workspace, reconciled.snapshot.scratch);
      if (existsSync(reconciled.snapshot.workspace) || existsSync(reconciled.snapshot.scratch))
        throw new CheckRunUnavailable('check-run: abandoned prepared snapshot removal was not verified');
      await markCheckRunPreparedSnapshotCustody(record.invocationId, record.nonce, 'removed', stateOptions);
      return;
    }
    if (!reconciled.physical && !reconciled.final)
      await markCheckRunPreparedSnapshotCustody(record.invocationId, record.nonce, 'unknown', stateOptions);
  } catch {
    try {
      const current = await getCheckRunStatus(record.invocationId, stateOptions);
      if (!current.physical && !current.final)
        await markCheckRunPreparedSnapshotCustody(record.invocationId, record.nonce, 'unknown', stateOptions);
    } catch {
      // Preserve the stored snapshot paths and conservative state for later reconciliation.
    }
  }
}

/** Prepare once, persist the complete binding and private execution state, then expose its owner-only descriptor. */
export async function prepareCheckRunInvocation(
  args: CheckRunArguments,
  descriptorFile: string,
  dependencies: CheckRunDependencies = {},
  processEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<CheckRunPreparedDescriptor> {
  if (!isAbsolute(descriptorFile)) throw new Error('--descriptor must be an absolute private JSON path');
  const stateOptions: CheckRunStateOptions = dependencies.stateDirectory
    ? { stateDirectory: dependencies.stateDirectory }
    : {};
  const stateDirectory = checkRunSettlementStateDirectory(stateOptions);
  const absoluteDescriptor = resolve(descriptorFile);
  const descriptorDirectory = resolve(dirname(absoluteDescriptor));
  if (realpathSync(descriptorDirectory) !== descriptorDirectory)
    throw new Error('--descriptor path cannot use a symlinked parent directory');
  const directoryStats = lstatSync(descriptorDirectory);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    (directoryStats.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && directoryStats.uid !== process.getuid())
  )
    throw new Error('--descriptor parent must be an owner-private real directory');
  const candidateRoot = absoluteDirectory(args.workspace, '--workspace');
  const descriptorInside = relative(realpathSync(candidateRoot), realpathSync(descriptorDirectory));
  if (
    descriptorInside === '' ||
    (!descriptorInside.startsWith(`..${sep}`) && descriptorInside !== '..' && !isAbsolute(descriptorInside))
  )
    throw new CheckRunUnavailable('--descriptor must be outside the candidate workspace');
  try {
    lstatSync(absoluteDescriptor);
    throw new Error('--descriptor path already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stateInside = relative(candidateRoot, stateDirectory);
  if (stateInside === '' || (!stateInside.startsWith(`..${sep}`) && stateInside !== '..' && !isAbsolute(stateInside)))
    throw new CheckRunUnavailable('check-run: private invocation state must be outside the candidate workspace');
  const trustedRoot = resolve(import.meta.dir, '..');
  const invocationId = randomUUID();
  const snapshotScratch = join(trustedRoot, '.temp', `check-run-${invocationId}`);
  const snapshotAllocation = { scratch: snapshotScratch, workspace: join(snapshotScratch, 'workspace') };
  const preparationIntent: CheckRunPreparationIntent = {
    schema: 1,
    type: 'check-run-preparation-intent',
    invocationId,
    descriptor: absoluteDescriptor,
    candidateWorkspace: candidateRoot,
    snapshot: { ...snapshotAllocation, sourceSha256: null, inputFiles: [] },
  };
  const intentReference = writeCheckRunPreparationIntent(
    checkRunPreparationIntentFile(absoluteDescriptor),
    preparationIntent,
  );
  let state: PreparedFinalRun | undefined;
  let registration: Awaited<ReturnType<typeof registerCheckRunInvocation>> | undefined;
  try {
    state = await prepareFinalRun(args, processEnvironment, trustedRoot, false, snapshotAllocation);
    registration = await registerCheckRunInvocation(state.binding, {
      ...stateOptions,
      invocationId,
      candidateWorkspace: state.candidateRoot,
      snapshot: {
        workspace: state.snapshot.workspace,
        scratch: state.snapshot.scratch,
        sourceSha256: state.snapshot.sourceHash,
        inputFiles: state.snapshot.inputFiles,
      },
      returns: state.returns,
      preparationIntent: intentReference,
      descriptorFile: absoluteDescriptor,
    });
    const descriptor = await persistCheckRunPreparedInvocation(registration, {
      ...stateOptions,
      candidateWorkspace: state.candidateRoot,
      snapshot: {
        workspace: state.snapshot.workspace,
        scratch: state.snapshot.scratch,
        sourceSha256: state.snapshot.sourceHash,
        inputFiles: state.snapshot.inputFiles,
      },
      returns: state.returns,
      descriptorFile: absoluteDescriptor,
      execution: state,
    });
    await discardCheckRunPreparationIntent(registration.invocationId, registration.nonce, stateOptions);
    return descriptor;
  } catch (error) {
    if (registration) {
      const current = await getCheckRunStatus(registration.invocationId, stateOptions);
      if (current.snapshot) await abandonClaimedPreparedInvocation(current, stateOptions);
      else await reconcileCheckRunPreparationIntent(absoluteDescriptor, undefined, stateOptions).catch(() => undefined);
    } else {
      await reconcileCheckRunPreparationIntent(absoluteDescriptor, undefined, stateOptions).catch((cleanupError) => {
        if (state) dependencies.onRetainSnapshot?.(state.snapshot);
        process.stderr.write(
          `check-run: prepared snapshot cleanup failed; retaining workspace=${snapshotAllocation.workspace}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
        );
      });
    }
    throw error;
  }
}

/** Claim and execute the exact durable preparation named by a matching caller-established FD 3 identity. */
export async function runPreparedCheckRunInvocation(
  descriptorFile: string,
  dependencies: CheckRunDependencies = {},
  signal = new AbortController().signal,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!isAbsolute(descriptorFile)) throw new Error('--descriptor must be an absolute private JSON path');
  const descriptor = readCheckRunPreparedDescriptor(descriptorFile);
  const receiptChannel = parseReceiptChannel(processEnvironment);
  if (
    !receiptChannel?.invocationId ||
    receiptChannel.invocationId !== descriptor.invocationId ||
    receiptChannel.nonce !== descriptor.nonce
  )
    throw new CheckRunUnavailable('check-run: run-prepared requires the matching caller-established FD 3 identity');
  const stateOptions: CheckRunStateOptions = dependencies.stateDirectory
    ? { stateDirectory: dependencies.stateDirectory }
    : {};
  const claimed = await claimCheckRunPreparedInvocation(descriptorFile, stateOptions);
  let state: PreparedCheckRunState;
  let context: PreparedFinalRun;
  try {
    if (
      claimed.descriptor.invocationId !== receiptChannel.invocationId ||
      claimed.descriptor.nonce !== receiptChannel.nonce ||
      checkRunBindingHash(claimed.descriptor.binding) !== checkRunBindingHash(descriptor.binding)
    )
      throw new CheckRunUnavailable('check-run: descriptor changed during its authenticated claim');
    state = preparedStateFromUnknown(claimed.execution, claimed.record);
    const descriptorDirectory = resolve(dirname(resolve(descriptorFile)));
    if (realpathSync(descriptorDirectory) !== descriptorDirectory)
      throw new CheckRunUnavailable('check-run: prepared descriptor parent became a symlinked directory');
    const descriptorInside = relative(realpathSync(state.candidateRoot), realpathSync(descriptorDirectory));
    if (
      descriptorInside === '' ||
      (!descriptorInside.startsWith(`..${sep}`) && descriptorInside !== '..' && !isAbsolute(descriptorInside))
    )
      throw new CheckRunUnavailable('check-run: prepared descriptor is inside the candidate workspace');
    context = await validatePreparedAuthorities(state, claimed.record, processEnvironment);
  } catch (error) {
    await abandonClaimedPreparedInvocation(claimed.record, stateOptions);
    await discardCheckRunPreparedExecution(claimed.record.invocationId, claimed.record.nonce, stateOptions).catch(
      () => undefined,
    );
    throw error;
  }
  try {
    return await runCheckWithFinalSettlement(state.args, dependencies, signal, processEnvironment, {
      context,
      record: claimed.record,
    });
  } finally {
    await discardCheckRunPreparedExecution(claimed.record.invocationId, claimed.record.nonce, stateOptions).catch(
      () => undefined,
    );
  }
}

/** Reconcile one retained invocation by host/run identity; this path never allocates another run. */
export async function reconcileRegisteredCheckRun(
  invocationId: string,
  hostsFile?: string,
  stateOptions: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  let initial = await getCheckRunStatus(invocationId, stateOptions);
  if (
    initial.final &&
    (initial.final.cleanup.disposition === 'settled' || initial.finalCustody?.reconciliation === 'settled')
  )
    return reconcileCheckRunInvocation(invocationId, { ...stateOptions, force: true });
  if (initial.final && !initial.physical)
    return reconcileCheckRunInvocation(invocationId, { ...stateOptions, force: true });
  if (!initial.physical && initial.phase === 'cancelled' && initial.snapshotCustody === 'removed') return initial;
  if (!initial.final && !initial.physical) {
    await cancelCheckRunInvocation(initial.invocationId, initial.nonce, 15, stateOptions);
    initial = await getCheckRunStatus(invocationId, stateOptions);
    if (!initial.physical) {
      const cancelled = await reconcileCheckRunInvocation(invocationId, { ...stateOptions, force: true });
      if (!cancelled.snapshot || !cancelled.candidateWorkspace)
        return await getCheckRunStatus(invocationId, stateOptions);
      try {
        cleanupWorktree(cancelled.candidateWorkspace, cancelled.snapshot.workspace, cancelled.snapshot.scratch);
        if (existsSync(cancelled.snapshot.workspace) || existsSync(cancelled.snapshot.scratch))
          throw new CheckRunUnavailable('check-run: abandoned frozen workspace removal was not verified');
        return await markCheckRunPreparedSnapshotCustody(invocationId, cancelled.nonce, 'removed', stateOptions);
      } catch (error) {
        await setCheckRunUnknown(
          invocationId,
          cancelled.nonce,
          error instanceof Error ? error.message.slice(0, 512) : 'prepared snapshot cleanup failed',
          stateOptions,
        ).catch(() => undefined);
        await markCheckRunPreparedSnapshotCustody(invocationId, cancelled.nonce, 'unknown', stateOptions).catch(
          () => undefined,
        );
        return await getCheckRunStatus(invocationId, stateOptions);
      }
    }
  }
  if (!hostsFile || !isAbsolute(hostsFile))
    throw new Error('check-run reconciliation of a physical invocation needs an absolute hosts file');
  const selectedHostsFile = resolve(hostsFile);
  return reconcileCheckRunInvocation(invocationId, {
    ...stateOptions,
    force: true,
    reconcilePhysical: async (physical, record) => {
      const unknown = (reason: string) => ({ disposition: 'unknown' as const, reason });
      if (!record.snapshot || !record.candidateWorkspace)
        return unknown('frozen workspace or candidate identity is unavailable; original custody is retained');
      const hostsStats = lstatSync(selectedHostsFile);
      if (!hostsStats.isFile() || hostsStats.isSymbolicLink())
        return unknown('selected host configuration is not a regular trusted file');
      const [hostConfigurationHash, closureHash] = await Promise.all([
        hashFile(selectedHostsFile),
        trustedProducerClosureHash(resolve(import.meta.dir, '..')),
      ]);
      if (hostConfigurationHash !== record.binding.hostsSha256)
        return unknown('selected host configuration differs from the retained invocation binding');
      if (closureHash !== record.binding.producerClosureSha256)
        return unknown('trusted producer closure differs from the retained invocation binding');
      const approvedHosts = performanceHosts(readHosts(selectedHostsFile));
      if (!approvedHosts.some(({ name }) => name === physical.host))
        return unknown('original physical host is absent from the bound performance host set');
      if (!existsSync(record.snapshot.workspace) || !existsSync(record.candidateWorkspace))
        return unknown('original frozen workspace or candidate workspace is unavailable');
      const candidateRoot = absoluteDirectory(record.candidateWorkspace, 'retained candidate workspace');
      let frozenSourceBefore = false;
      let candidateSourceBefore = false;
      try {
        frozenSourceBefore =
          (await inputFingerprint(record.snapshot.workspace, record.snapshot.inputFiles, record.returns)) ===
          record.snapshot.sourceSha256;
        candidateSourceBefore =
          (await inputFingerprint(candidateRoot, workspaceFiles(candidateRoot), record.returns)) ===
          record.snapshot.sourceSha256;
      } catch {
        frozenSourceBefore = false;
        candidateSourceBefore = false;
      }

      const remote = await reconcileRemoteRun({
        hosts: approvedHosts,
        physical,
        workspace: record.snapshot.workspace,
        returns: record.returns,
        expectedSourceSha256: record.binding.sourceSha256,
        allowedHosts: approvedHosts.map(({ name }) => name),
      });
      const originalTransportIdentity = record.transportChild
        ? await reapRetainedTransportChild(record.transportChild)
        : 'unknown';
      const originalTransportReaped = originalTransportIdentity === 'gone-or-replaced';
      const reconciledRemote = {
        ...remote,
        transportChildReaped: remote.transportChildReaped && originalTransportReaped,
      };
      if (!remote.native)
        return {
          ...unknown('original physical run has no retained native terminal receipt; no replacement was started'),
          transportIdentity: originalTransportIdentity,
        };
      const remoteNativeDigest = checkRunNativeReceiptDigest(remote.native);
      if (
        record.native &&
        (record.native.exitCode !== remote.native.exitCode || record.native.receiptSha256 !== remoteNativeDigest)
      )
        return {
          ...unknown('original host native outcome differs from the retained terminal event'),
          transportIdentity: originalTransportIdentity,
        };

      let local: ReturnedOutputResult | undefined;
      let returnFailure: unknown;
      if (candidateSourceBefore && frozenSourceBefore) {
        try {
          clearDeclaredArtifacts(candidateRoot, record.returns);
          const stage = join(record.snapshot.scratch, 'reconciled-returns');
          rmSync(stage, { recursive: true, force: true });
          local = await copyReturnedOutputs(
            record.snapshot.workspace,
            candidateRoot,
            stage,
            physical.run,
            record.returns,
            {
              manifest: remote.returns,
              terminal: {
                host: physical.host,
                run: physical.run,
                sourceSha256: record.binding.sourceSha256,
                exitCode: remote.native.exitCode,
              },
              validateSource: async () => {
                if (remote.preparedInputs?.sourceSha256 !== record.binding.sourceSha256)
                  throw new CheckRunUnavailable('check-run: reconciled tree lacks matching physical prepared custody');
              },
            },
          );
        } catch (error) {
          returnFailure = error;
        }
      } else {
        returnFailure = new CheckRunUnavailable(
          'check-run: retained source changed before reconciliation output restoration',
        );
      }
      const returnDisposition = finalReturns(remote.returns, record.binding.returnsSha256, local, record.returns);
      let source: CheckRunCleanupDisposition['source'] = 'unknown';
      try {
        const frozenNow = await inputFingerprint(record.snapshot.workspace, record.snapshot.inputFiles, record.returns);
        const candidateNow = await inputFingerprint(candidateRoot, workspaceFiles(candidateRoot), record.returns);
        source =
          frozenNow === record.snapshot.sourceSha256 && candidateNow === record.snapshot.sourceSha256
            ? 'verified'
            : 'changed';
      } catch {
        source = 'unknown';
      }
      const prepared = finalPreparedInputs(remote.preparedInputs);
      if (prepared.status !== 'verified' || prepared.sourceSha256 !== record.binding.sourceSha256)
        returnFailure ??= new CheckRunUnavailable(
          'check-run: retained prepared-input evidence is unavailable or mismatched',
        );
      const returnComplete = returnDisposition.status === 'empty' || returnDisposition.status === 'restored';
      let localWorktree: CheckRunCleanupDisposition['localWorktree'] = 'retained';
      if (
        remoteCleanupIsVerified(remote) &&
        reconciledRemote.transportChildReaped &&
        source === 'verified' &&
        prepared.status === 'verified' &&
        returnComplete &&
        !returnFailure
      ) {
        try {
          cleanupWorktree(candidateRoot, record.snapshot.workspace, record.snapshot.scratch);
          localWorktree =
            !existsSync(record.snapshot.workspace) && !existsSync(record.snapshot.scratch) ? 'removed' : 'unknown';
        } catch {
          localWorktree = existsSync(record.snapshot.workspace) ? 'retained' : 'unknown';
        }
      }
      const cleanupFailures = [
        ...remote.cleanup.failures,
        ...(!remoteCleanupIsVerified(remote) ? ['remote cleanup is unverified'] : []),
        ...(reconciledRemote.transportChildReaped ? [] : ['original transport child is unverified']),
      ].slice(0, 64);
      const cleanup = finalCleanup(
        reconciledRemote,
        source,
        localWorktree,
        cleanupFailures,
        prepared,
        returnDisposition,
      );
      const primaryFailures = returnFailure
        ? [returnFailure instanceof Error ? returnFailure.message.slice(0, 512) : 'returns restoration failed']
        : [];
      const final = createCheckRunFinalSettlement({
        invocationId: record.invocationId,
        nonce: record.nonce,
        binding: record.binding,
        physical,
        native: {
          exitCode: remote.native.exitCode,
          lifetimeFailure: remote.native.lifetimeFailure !== null,
          receiptSha256: remoteNativeDigest,
        },
        preparedInputs: prepared,
        returns: returnDisposition,
        cleanup,
        failures: { primary: primaryFailures, cleanup: cleanupFailures },
      });
      return { disposition: 'settled', final, transportIdentity: originalTransportIdentity };
    },
  });
}

/** Recover a pre-exposure snapshot intent, or route an exposed descriptor to its original invocation. */
export async function reconcileCheckRunPreparationIntent(
  descriptorFile: string,
  hostsFile?: string,
  stateOptions: CheckRunStateOptions = {},
): Promise<
  | CheckRunInvocationRecord
  | {
      schema: 1;
      type: 'check-run-preparation-reconciliation';
      invocationId: string;
      snapshotCustody: 'removed';
      preparationIntent: 'removed';
    }
> {
  if (!isAbsolute(descriptorFile)) throw new Error('--descriptor must be an absolute private JSON path');
  const absoluteDescriptor = resolve(descriptorFile);
  let descriptorExists = false;
  try {
    const stats = lstatSync(absoluteDescriptor);
    descriptorExists = true;
    if (!stats.isFile() || stats.isSymbolicLink())
      throw new CheckRunUnavailable('check-run: prepared descriptor is not a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (descriptorExists) {
    const { descriptor, reference } = readCheckRunPreparedDescriptorReference(absoluteDescriptor);
    const record = await getCheckRunStatus(descriptor.invocationId, stateOptions);
    if (
      record.nonce !== descriptor.nonce ||
      checkRunBindingHash(record.binding) !== checkRunBindingHash(descriptor.binding) ||
      !record.descriptor ||
      record.descriptor.file !== reference.file ||
      record.descriptor.sha256 !== reference.sha256
    )
      throw new CheckRunUnavailable('check-run: exposed descriptor differs from the retained invocation');
    return reconcileRegisteredCheckRun(descriptor.invocationId, hostsFile, stateOptions);
  }

  const intentFile = checkRunPreparationIntentFile(absoluteDescriptor);
  const { intent, reference: intentReference } = readCheckRunPreparationIntentReference(intentFile);
  if (intent.descriptor !== absoluteDescriptor)
    throw new CheckRunUnavailable('check-run: preparation intent names a different descriptor');
  const stateDirectory = checkRunSettlementStateDirectory(stateOptions);
  const recordFile = join(stateDirectory, `${intent.invocationId}.json`);
  if (existsSync(recordFile)) {
    const record = await getCheckRunStatus(intent.invocationId, stateOptions);
    if (
      record.candidateWorkspace !== intent.candidateWorkspace ||
      !record.preparationIntent ||
      record.preparationIntent.file !== intentReference.file ||
      record.preparationIntent.sha256 !== intentReference.sha256 ||
      !record.snapshot ||
      record.snapshot.workspace !== intent.snapshot.workspace ||
      record.snapshot.scratch !== intent.snapshot.scratch ||
      (intent.snapshot.sourceSha256 !== null && record.snapshot.sourceSha256 !== intent.snapshot.sourceSha256)
    )
      throw new CheckRunUnavailable('check-run: preparation intent differs from the durable snapshot custody');
    return reconcileRegisteredCheckRun(intent.invocationId, hostsFile, stateOptions);
  }

  const candidateRoot = absoluteDirectory(intent.candidateWorkspace, '--workspace');
  const scratchParent = resolve(dirname(intent.snapshot.scratch));
  if (existsSync(scratchParent)) {
    if (realpathSync(scratchParent) !== scratchParent)
      throw new CheckRunUnavailable('check-run: snapshot intent parent is not canonical');
    const scratchParentStats = lstatSync(scratchParent);
    if (!scratchParentStats.isDirectory() || scratchParentStats.isSymbolicLink())
      throw new CheckRunUnavailable('check-run: snapshot intent parent is not a real directory');
  }
  const scratchInside = relative(candidateRoot, intent.snapshot.scratch);
  if (
    scratchInside === '' ||
    (!scratchInside.startsWith(`..${sep}`) && scratchInside !== '..' && !isAbsolute(scratchInside))
  )
    throw new CheckRunUnavailable('check-run: snapshot intent is inside its candidate workspace');
  if (existsSync(intent.snapshot.scratch)) {
    const scratchStats = lstatSync(intent.snapshot.scratch);
    if (
      !scratchStats.isDirectory() ||
      scratchStats.isSymbolicLink() ||
      (scratchStats.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && scratchStats.uid !== process.getuid())
    )
      throw new CheckRunUnavailable('check-run: snapshot intent scratch directory is not owner-private');
  }
  if (existsSync(intent.snapshot.workspace)) {
    cleanupWorktree(candidateRoot, intent.snapshot.workspace, intent.snapshot.scratch);
  } else {
    rmSync(intent.snapshot.scratch, { recursive: true, force: true });
  }
  if (existsSync(intent.snapshot.workspace) || existsSync(intent.snapshot.scratch))
    throw new CheckRunUnavailable('check-run: pre-exposure snapshot removal was not verified');
  removeCheckRunPreparationIntentFile(intentReference, candidateRoot, stateOptions);
  return {
    schema: 1,
    type: 'check-run-preparation-reconciliation',
    invocationId: intent.invocationId,
    snapshotCustody: 'removed',
    preparationIntent: 'removed',
  };
}

export type CheckRunTransportIdentityDependencies = {
  platform?: string;
  readBootId?: () => string;
  readProcStat?: (pid: number) => string;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
};

/** Reap only a positively identified Linux child; identity uncertainty never grants signal authority. */
export async function reapRetainedTransportChild(
  identity: CheckRunTransportChildIdentity,
  dependencies: CheckRunTransportIdentityDependencies = {},
): Promise<'live-same' | 'gone-or-replaced' | 'unknown'> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'linux') return 'unknown';
  const readBootId = dependencies.readBootId ?? (() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  const readProcStat = dependencies.readProcStat ?? ((pid: number) => readFileSync(`/proc/${pid}/stat`, 'utf8'));
  const sendSignal = dependencies.sendSignal ?? ((pid, selectedSignal) => process.kill(pid, selectedSignal));
  const now = dependencies.now ?? Date.now;
  const pollIntervalMs = Math.max(1, Math.min(dependencies.pollIntervalMs ?? 50, 1000));
  const termTimeoutMs = Math.max(0, Math.min(dependencies.termTimeoutMs ?? 10_000, 10_000));
  const killTimeoutMs = Math.max(0, Math.min(dependencies.killTimeoutMs ?? 10_000, 10_000));
  const sleep =
    dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const observe = (): 'live-same' | 'gone-or-replaced' | 'unknown' => {
    let bootId: string | null = null;
    try {
      const selected = readBootId().trim();
      if (/^[0-9a-f-]{36}$/i.test(selected)) bootId = selected;
    } catch {
      // A boot-ID read failure is uncertainty, not evidence of process absence.
    }
    if (bootId !== null && bootId !== identity.bootId) return 'gone-or-replaced';

    let stat: string;
    try {
      stat = readProcStat(identity.pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone-or-replaced';
      return 'unknown';
    }
    const commandEnd = stat.lastIndexOf(')');
    const prefix = stat.slice(0, commandEnd + 1);
    const fields =
      commandEnd >= 0
        ? stat
            .slice(commandEnd + 1)
            .trim()
            .split(/\s+/)
        : [];
    if (
      !new RegExp(`^${identity.pid} \\(.+\\)$`).test(prefix) ||
      fields.length < 20 ||
      !/^[A-Za-z]$/.test(fields[0] ?? '') ||
      !/^\d+$/.test(fields[19] ?? '')
    )
      return 'unknown';
    if (fields[19] !== identity.start) return 'gone-or-replaced';
    if (bootId === null) return 'unknown';
    return 'live-same';
  };

  const signalExact = (signal: NodeJS.Signals): 'live-same' | 'gone-or-replaced' | 'unknown' => {
    const state = observe();
    if (state !== 'live-same') return state;
    try {
      sendSignal(identity.pid, signal);
      return 'live-same';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone-or-replaced';
      return 'unknown';
    }
  };

  const waitForExit = async (milliseconds: number): Promise<'live-same' | 'gone-or-replaced' | 'unknown'> => {
    const deadline = now() + milliseconds;
    const maxPolls = Math.ceil(milliseconds / pollIntervalMs) + 1;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const state = observe();
      if (state !== 'live-same') return state;
      if (now() >= deadline) return 'live-same';
      try {
        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
      } catch {
        return 'unknown';
      }
    }
    return observe();
  };

  try {
    const term = signalExact('SIGTERM');
    if (term !== 'live-same') return term;
    const afterTerm = await waitForExit(termTimeoutMs);
    if (afterTerm !== 'live-same') return afterTerm;
    const kill = signalExact('SIGKILL');
    if (kill !== 'live-same') return kill;
    return await waitForExit(killTimeoutMs);
  } catch {
    return 'unknown';
  }
}

function usage(): string {
  return [
    'Usage:',
    '  bun scripts/check-run.ts --hosts <absolute-hosts-json> --workspace <absolute-candidate-root> --cwd <workspace-relative-directory> --source-revision <full-candidate-commit> --env-file <absolute-environment-json> [--returns <workspace-relative-path>]... -- <original-argv...>',
    '  bun scripts/check-run.ts prepare --descriptor <absolute-private-json> <existing-check-arguments...>',
    '  bun scripts/check-run.ts run-prepared --descriptor <absolute-private-json>',
  ].join('\n');
}

export async function runCheckRunCli(
  argv: readonly string[],
  dependencies: CheckRunDependencies = {},
  processEnvironment: NodeJS.ProcessEnv = process.env,
  signal = new AbortController().signal,
): Promise<number> {
  try {
    const [operation, ...remaining] = argv;
    if (operation === 'prepare') {
      const separator = remaining.indexOf('--');
      const optionsEnd = separator < 0 ? remaining.length : separator;
      const descriptorAt = remaining.slice(0, optionsEnd).indexOf('--descriptor');
      if (descriptorAt < 0 || descriptorAt + 1 >= optionsEnd)
        throw new Error('prepare requires --descriptor <absolute-private-json>');
      const descriptorFile = remaining[descriptorAt + 1]!;
      const checkArgs = [...remaining.slice(0, descriptorAt), ...remaining.slice(descriptorAt + 2)];
      const descriptor = await prepareCheckRunInvocation(
        parseCheckRunArguments(checkArgs),
        descriptorFile,
        dependencies,
        processEnvironment,
      );
      process.stdout.write(`${JSON.stringify(descriptor)}\n`);
      return 0;
    }
    if (operation === 'run-prepared') {
      if (remaining.length !== 2 || remaining[0] !== '--descriptor')
        throw new Error('run-prepared requires exactly --descriptor <absolute-private-json>');
      return await runPreparedCheckRunInvocation(remaining[1]!, dependencies, signal, processEnvironment);
    }
    return await runCheck(parseCheckRunArguments(argv), dependencies, signal, processEnvironment);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(usage());
    return error instanceof CheckRunUnavailable ? error.exitCode : 2;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const cancellation = executionCancellationFromEnvironment();
  let durableCancel: ((signal: 1 | 2 | 15) => Promise<void>) | undefined;
  let received: 1 | 2 | 15 | undefined;
  for (const [name, number] of [
    ['SIGHUP', 1],
    ['SIGINT', 2],
    ['SIGTERM', 15],
  ] as const) {
    process.on(name, () => {
      received ??= number;
      if (durableCancel) {
        void durableCancel(number).finally(() => controller.abort());
      } else {
        if (cancellation) requestExecutionCancellation(cancellation, number);
        controller.abort();
      }
    });
  }
  process.exitCode = await runCheckRunCli(
    process.argv.slice(2),
    { onDurableCancellationReady: (cancel) => (durableCancel = cancel) },
    process.env,
    controller.signal,
  );
  if (received !== undefined) process.exitCode = 128 + received;
}
