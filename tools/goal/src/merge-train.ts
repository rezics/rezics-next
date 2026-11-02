import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TrainResolver, TrainResolverInfrastructureError, type TrainConflict } from './train-resolver.ts';
import { groupMembers, processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import { authenticatedManager } from './priority-authority.ts';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import defaults from '../defaults.json';
import { controlPlaneReleaseBrief, matchesPath, parseBrief, readRiskOwnership } from './briefs.ts';
import { StaleAttemptError } from './contracts.ts';
import type {
  AttemptFence,
  ControlPlaneBatchManifest,
  ControlPlaneBatchRefContinuation,
  ControlPlaneBatchResult,
  ControlPlaneBatchDisposition,
  ControlPlaneBatchSupersession,
  ControlPlaneBatchSupersessionResult,
  ControlPlaneBatchSource,
  ControlPlaneScopeApprovalReceipt,
  ControlPlaneBatchDevHandoff,
  ControlPlaneBatchDevHandoffRequest,
  AttemptRef,
  GateOutcome,
  GateOutcomeSink,
  GateStage,
  LandingRequest,
  RebaseConflictContext,
} from './contracts.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SqliteLandingQueue, type LandingEntry } from './land.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import type { IntegrationTarget, Task } from './types.ts';
import { WorkerStore } from './store.ts';
import { assertManagerLandingEvidence } from './manager-landing.ts';
import {
  WorkspaceController,
  isAncestor as workspaceAncestor,
  taskCommits,
  taskChangedPaths,
  workspaceCommits,
} from './workspace.ts';
import {
  changedFiles,
  diffLineCount,
  firstFailure,
  gateRunner,
  gateEnvironment,
  git,
  processGroupRunner,
  nonGeneratedFiles,
  outsideScope,
  type GateResult,
  type GateRunner,
} from './merge.ts';
import { canonicalConflictPaths, makeRebaseConflictContext } from './conflict-progress.ts';
import { renameSync } from 'node:fs';

import type { AffectedTestCheck, AffectedTestResult } from './types.ts';
import { CHECK_HOST_TRANSPORT } from './records.ts';
import { siblingTestCommand, siblingTestFiles } from './affected-tests.ts';
import { installShared } from './shared-dependencies.ts';
import {
  assertControlPlaneMember,
  controlPlaneBatchId,
  controlPlaneScopeApproval,
  parseControlPlaneBatchManifest,
  parseControlPlaneBatchRefContinuation,
} from './control-plane-batch.ts';

export type DerivedFile = {
  path: string;
  stage: 'integration' | 'promotion';
  command: string[];
  /** Source paths whose changes should refresh this output when a dev landing is assembled. */
  inputs?: string[];
};
export type IntegrationCheck = { paths: string[]; command: string[] };
import { resolveImportConflicts } from './import-conflicts.ts';
const defaultDerivedFiles = defaults.derivedFiles as DerivedFile[];
const defaultJsonMessageConflicts = defaults.jsonMessageConflicts as string[];

/** Select the integration checks that the landing path matcher will run for these changed files. */
export function integrationChecksForFiles(
  changed: readonly string[],
  checks: readonly IntegrationCheck[],
): IntegrationCheck[] {
  return checks.filter((check) => changed.some((path) => matchesPath(path, check.paths)));
}

export function rootTypecheckCommand(changed: readonly string[]): string[] {
  return ['env', `TYPECHECK_CHANGED=${changed.join('\n')}`, 'bun', 'scripts/typecheck.ts'];
}

function compilerInfrastructureFailure(output: string, timedOut: boolean): boolean {
  return (
    timedOut ||
    checkTransportFailed(output) ||
    /(?:docker|database).*(?:failed|unavailable|timed out)|ETIMEDOUT|out of memory|spawn .*?(?:ENOENT|EACCES)/i.test(
      output,
    )
  );
}

function compilerOutputMatchesPath(output: string, root: string, file: string): boolean {
  if (output.includes(file) || output.includes(join(root, file))) return true;
  const absolute = resolve(root, file);
  let directory = dirname(absolute);
  while (directory.startsWith(`${root}/`) && directory !== root) {
    if (existsSync(join(directory, 'package.json'))) {
      const workspacePath = relative(directory, absolute).replace(/\\/g, '/');
      return output.includes(workspacePath);
    }
    directory = dirname(directory);
  }
  return false;
}

/** Keep control-plane train fixtures hermetic even if package defaults name real workspace checks. */
export function landingAffectedChecks(
  changed: readonly string[],
  _workspace: boolean,
  explicit: readonly AffectedTestCheck[] | undefined,
): AffectedTestCheck[] {
  const testDefaults = process.env.REZICS_GOAL_TEST_ENVIRONMENT === '1';
  const checks = [...(explicit ?? (testDefaults ? [] : defaults.affectedTests))];
  return checks.filter((check) => changed.some((path) => matchesPath(path, check.paths)));
}
/** A landing may change only files the formatter does not handle, such as SQL; that is not a formatter failure. */
export const FORMAT_FLAGS = ['--no-error-on-unmatched-pattern'];

/** Capture only a newly added disposable train tree, before any check can leave immutable fixture directories. */
export function captureTrainWorktreeRemoval(tree: string): () => void {
  const path = resolve(tree);
  const parentPath = dirname(path);
  const parent = realpathSync(parentPath);
  const rootIdentity = lstatSync(path);
  const parentIdentity = lstatSync(parent);
  const sameInode = (left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>) =>
    left.dev === right.dev && left.ino === right.ino;
  const refuse = () => new Error(`Refusing cleanup of replaced train worktree: ${path}`);
  if (!rootIdentity.isDirectory() || !parentIdentity.isDirectory()) throw refuse();
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const descriptorPath = (fd: number) => `/proc/self/fd/${fd}`;
  const prepare = (fd: number) => {
    const stat = fstatSync(fd);
    if (stat.dev !== rootIdentity.dev) throw new Error(`Refusing cleanup across train filesystem boundary: ${path}`);
    if ((stat.mode & 0o700) !== 0o700) fchmodSync(fd, (stat.mode & 0o7777) | 0o700);
    for (const name of readdirSync(descriptorPath(fd))) {
      const child = join(descriptorPath(fd), name);
      const before = lstatSync(child);
      // Directory permissions govern deletion. Never chmod package files (which can be hardlinks), or follow links
      // to shared dependency stores, another worktree, or any other outside directory.
      if (!before.isDirectory()) continue;
      const childFd = openSync(child, flags);
      try {
        if (!sameInode(before, fstatSync(childFd))) throw refuse();
        prepare(childFd);
        if (!sameInode(before, lstatSync(child))) throw refuse();
      } finally {
        closeSync(childFd);
      }
    }
  };
  return () => {
    if (realpathSync(parentPath) !== parent) throw refuse();
    const parentFd = openSync(parent, flags);
    try {
      if (!sameInode(parentIdentity, fstatSync(parentFd))) throw refuse();
      const rootFd = openSync(join(descriptorPath(parentFd), basename(path)), flags);
      try {
        if (!sameInode(rootIdentity, fstatSync(rootFd))) throw refuse();
        prepare(rootFd);
        if (!sameInode(rootIdentity, lstatSync(path))) throw refuse();
      } finally {
        closeSync(rootFd);
      }
    } finally {
      closeSync(parentFd);
    }
  };
}

/** Kernel summaries, FAIL lines and heading-scoped (fail) name files; passing headings, Bun's repeated summary and stack frames do not. */
export function failingTestFiles(output: string): string[] {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const files = new Set<string>();
  const add = (file: string) => files.add(file.replace(/^\.\//, ''));
  let summarized = false;
  for (const summary of clean.matchAll(/tests failed for (\d+) file\(s\):\r?\n([^]*?)(?=\n\s*at |$)/gi)) {
    summarized = true;
    files.clear(); // The final summary excludes files that passed the check's own rerun.
    for (const line of summary[2]!.split(/\r?\n/).slice(0, Number(summary[1]))) {
      const file = line.trim();
      if (file) add(file);
    }
  }
  if (summarized) return [...files].sort();
  for (const match of clean.matchAll(
    /^\s*(?:FAIL\s+([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?)|([^\s:]+\.(?:test|spec)\.[cm]?[jt]sx?):[^\n]*(?:fail|error))/gim,
  ))
    add((match[1] ?? match[2])!);
  let currentFile: string | undefined;
  for (const line of clean.split(/\r?\n/)) {
    const heading = line.match(/^([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/);
    if (heading) currentFile = heading[1];
    else if (/^\d+ tests? failed:/.test(line.trim())) currentFile = undefined;
    else if (currentFile && /^\s*\(fail\)/.test(line)) add(currentFile);
  }
  return [...files].sort();
}

function checkTransportFailed(output: string): boolean {
  return (
    CHECK_HOST_TRANSPORT.test(output) ||
    /remote-check: (?:connection to .+ failed during .+ before a result|no check host answered)/.test(output)
  );
}

function checkEnvironmentFailed(output: string): boolean {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  return /^kernel check: environment failure: database storage full \(SQLSTATE 53100\)(?: on .*)?$/m.test(clean);
}

export type CandidateGitResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type CandidateGitRunner = (cwd: string, args: readonly string[]) => CandidateGitResult | undefined;

function candidateGit(cwd: string, args: string[], run?: CandidateGitRunner): CandidateGitResult {
  try {
    const injected = run?.(cwd, args);
    if (injected) return injected;
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 });
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function candidateGitDetails(result: CandidateGitResult): string {
  const detail = (value: string) => JSON.stringify(value.replace(/[\r\n\t]+/g, ' ').slice(0, 800));
  return [
    `exit=${result.status === null ? 'null' : result.status}`,
    `signal=${result.signal ?? 'none'}`,
    ...(result.error ? [`error=${detail(result.error.message)}`] : []),
    ...(result.stdout ? [`stdout=${detail(result.stdout)}`] : []),
    ...(result.stderr ? [`stderr=${detail(result.stderr)}`] : []),
  ].join(' ');
}

function nulPaths(result: CandidateGitResult): string[] {
  return result.stdout.split('\0').filter(Boolean);
}

function boundedPaths(paths: readonly string[]): string {
  const exact = paths.slice(0, 64).map((path) => JSON.stringify(path));
  return `[${exact.join(', ')}]${paths.length > exact.length ? ` (${paths.length - exact.length} more omitted)` : ''}`;
}

/** Record a content-safe diff report before refusing and removing a candidate worktree. */
function candidateIntegrityEvidence(
  cwd: string,
  expected: string,
  phase: string,
  logPath: string,
  observedHead: string,
  quiet: CandidateGitResult,
  run?: CandidateGitRunner,
): void {
  const stagedResult = candidateGit(cwd, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--'], run);
  const unstagedResult = candidateGit(cwd, ['diff', '--name-only', '-z', '--'], run);
  const trackedResult = candidateGit(cwd, ['diff', '--name-only', '-z', expected, '--'], run);
  const headResult =
    observedHead === expected
      ? undefined
      : candidateGit(cwd, ['diff', '--name-only', '-z', expected, observedHead, '--'], run);
  const staged = nulPaths(stagedResult);
  const unstaged = nulPaths(unstagedResult);
  const tracked = nulPaths(trackedResult);
  const committed = headResult ? nulPaths(headResult) : [];
  const report = [
    `Candidate integrity evidence phase=${phase}`,
    `expected HEAD=${expected}`,
    `observed HEAD=${observedHead}`,
    `git diff --quiet HEAD --: ${candidateGitDetails(quiet)}`,
    `tracked paths vs expected HEAD: ${boundedPaths(tracked)}`,
    `staged paths vs observed HEAD: ${boundedPaths(staged)}`,
    `unstaged paths: ${boundedPaths(unstaged)}`,
    `committed paths vs expected HEAD: ${boundedPaths(committed)}`,
    [
      'path-query exits:',
      `tracked=${candidateGitDetails(trackedResult)};`,
      `staged=${candidateGitDetails(stagedResult)};`,
      `unstaged=${candidateGitDetails(unstagedResult)}`,
      ...(headResult ? [`; committed=${candidateGitDetails(headResult)}`] : []),
    ].join(' '),
  ];
  const stat = candidateGit(cwd, ['diff', '--stat', '--no-ext-diff', expected, '--'], run);
  report.push(
    `safe diff stat: ${stat.status === 0 ? stat.stdout.trim().slice(0, 4000) || '(empty)' : candidateGitDetails(stat)}`,
  );
  if (tracked.length <= 64 && tracked.length) {
    const patch = candidateGit(
      cwd,
      ['diff', '--no-ext-diff', '--no-color', '--unified=0', expected, '--', ...tracked],
      run,
    );
    if (patch.status === 0) {
      const redacted = patch.stdout
        .split(/\r?\n/)
        .map((line) =>
          (line.startsWith('+') && !line.startsWith('+++ ')) || (line.startsWith('-') && !line.startsWith('--- '))
            ? `${line[0]}[content redacted]`
            : line,
        )
        .slice(0, 80)
        .join('\n')
        .slice(0, 5000);
      report.push(`safe patch (changed line contents redacted):\n${redacted || '(empty)'}`);
    } else report.push(`safe patch unavailable: ${candidateGitDetails(patch)}`);
  } else
    report.push(
      `safe patch omitted: ${tracked.length > 64 ? 'path bound exceeded' : 'no tracked paths were returned'}`,
    );
  appendFileSync(logPath, `${report.join('\n')}\n`);
}

/** A candidate must still be the checked commit and have no tracked working-tree changes after each check. */
export function assertCandidateIntegrity(
  cwd: string,
  expected: string,
  phase: string,
  logPath: string,
  run?: CandidateGitRunner,
): void {
  const head = candidateGit(cwd, ['rev-parse', 'HEAD'], run);
  const observedHead = head.status === 0 ? head.stdout.trim() : '(unavailable)';
  const quiet = candidateGit(cwd, ['diff', '--quiet', 'HEAD', '--'], run);
  if (head.status === 0 && observedHead === expected && quiet.status === 0 && !quiet.error && !quiet.signal) {
    appendFileSync(logPath, `Candidate integrity verified phase=${phase} HEAD=${expected}\n`);
    return;
  }

  candidateIntegrityEvidence(cwd, expected, phase, logPath, observedHead, quiet, run);
  if (head.status !== 0 || head.error || head.signal)
    throw new Error(
      `Candidate Git infrastructure failure phase=${phase}: git rev-parse HEAD ${candidateGitDetails(head)}; expected HEAD=${expected}; evidence recorded before candidate cleanup`,
    );
  if (observedHead !== expected)
    throw new Error(
      `Candidate integrity violation phase=${phase}: HEAD changed from ${expected} to ${observedHead}; evidence recorded before candidate cleanup`,
    );
  if (quiet.status === 1 && !quiet.error && !quiet.signal)
    throw new Error(
      `Candidate integrity violation phase=${phase}: tracked working-tree changes detected (git diff --quiet HEAD -- exited 1); evidence recorded before candidate cleanup`,
    );
  throw new Error(
    `Candidate Git infrastructure failure phase=${phase}: git diff --quiet HEAD -- ${candidateGitDetails(quiet)}; expected HEAD=${expected}; evidence recorded before candidate cleanup`,
  );
}

/** A rejected owned command cannot release its siblings' worktree or leases early. */
async function settleOwnedCommands<T>(commands: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(commands);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

/** No wall timeout: a check waiting for a shared host slot is still queued. */
export async function runAffectedTest(
  command: readonly string[],
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
  options?: { signal: AbortSignal },
): Promise<AffectedTestResult> {
  const started = Date.now();
  let output = '';
  let passed = false;
  let transportUnverified = false;
  let environmentUnverified = false;
  for (let retry = 0; retry < 2; retry++) {
    appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
    const result = await processGroupRunner(undefined, undefined, env, false)(command, cwd, logPath, options);
    output = result.output;
    passed = result.passed;
    environmentUnverified = checkEnvironmentFailed(output);
    transportUnverified = !passed && checkTransportFailed(output);
    if (!transportUnverified) break;
    if (retry === 0) appendFileSync(logPath, 'Check-host transport failed; retrying once\n');
  }
  const selectionUnverified = /^Affected mode: unverified, 0 of \d+ test files selected \(.+\)$/m.test(output);
  const unverified = transportUnverified || environmentUnverified || (passed && selectionUnverified);
  const status = unverified ? 'unverified' : passed ? 'passed' : 'failed';
  const durationMs = Date.now() - started;
  appendFileSync(logPath, `Affected test: ${status} in ${durationMs} ms\n`);
  return {
    command: [...command],
    status,
    failingFiles: passed || unverified ? [] : failingTestFiles(output),
    durationMs,
    output,
  };
}

export async function runIntegrationChecks(
  commands: readonly (readonly string[])[],
  cwd: string,
  logPath: string,
  execute: GateRunner = gateRunner(600_000),
): Promise<GateResult & { failedCommand?: readonly string[] }> {
  // Web's recorded-response check regenerates the web client first, which takes about two minutes on a loaded host.
  let output = '';
  let passed = true,
    timedOut = false;
  let failedCommand: readonly string[] | undefined;
  const record = (command: readonly string[], result: GateResult, started: number) => {
    output += result.output;
    if (!result.passed && !failedCommand) failedCommand = [...command];
    passed &&= result.passed;
    timedOut ||= result.timedOut;
    appendFileSync(
      logPath,
      `(${command.join(' ')}: ${result.passed ? 'passed' : 'failed'} in ${Math.round((Date.now() - started) / 1000)} s)\n`,
    );
  };
  // Every check runs: a later check may be the only one that exercises its own errors. Installing
  // dependencies changes the tree the others read, so it runs first and alone; the remaining checks only read the tree
  // and run at once, each into its own log section, which keeps the landing as long as its slowest check.
  // A check that installs or generates writes the tree, so those run one at a time, before and after the read-only
  // group.
  const writes = (command: readonly string[]) => / install\b|\bgenerate\b/.test(` ${command.join(' ')}`);
  const install = commands.filter((command) => command[0] === 'bun' && command[1] === 'install');
  const rest = commands.filter((command) => !install.includes(command) && !writes(command));
  const after = commands.filter((command) => !install.includes(command) && writes(command));
  for (const command of install) {
    appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
    const started = Date.now();
    record(command, await execute(command, cwd, logPath), started);
  }
  const parallel = await Promise.allSettled(
    rest.map(async (command, index) => {
      const own = `${logPath}.check-${index}`;
      writeFileSync(own, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
      const started = Date.now();
      const result = await execute(command, cwd, own);
      return { command, result, started, own };
    }),
  );
  for (const settled of parallel) {
    // Rejected commands keep their exact section log. Every sibling has settled before custody can be released.
    if (settled.status === 'rejected') continue;
    const { command, result, started, own } = settled.value;
    appendFileSync(logPath, readFileSync(own, 'utf8'));
    rmSync(own, { force: true });
    record(command, result, started);
  }
  const rejected = parallel.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  for (const command of after) {
    appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
    const started = Date.now();
    record(command, await execute(command, cwd, logPath), started);
  }
  return { passed, output, timedOut, ...(failedCommand ? { failedCommand } : {}) };
}

// While dev already fails a check, a branch is still refused for error lines that dev does not have. Source
// positions, durations and TypeScript's elided member counts are dropped so that a moved line, a slower run or a grown
// type compares equal; repeats count.
export function newErrorLines(output: string, baseline: string): string[] {
  const errors = (text: string) =>
    text
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .filter((line) => /\berror\b/i.test(line))
      .map((line) =>
        line
          .replace(/\(\d+,\s*\d+\)|:\d+:\d+\b/g, '')
          .replace(/\b\d+(?:\.\d+)?\s*m?s\b/g, '')
          // TypeScript elides long types as '... N more ...'; a branch that grows the type keeps the same error.
          .replace(/\.\.\. \d+ more \.\.\./g, '... more ...')
          .trim(),
      );
  const remaining = new Map<string, number>();
  for (const line of errors(baseline)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of errors(output)) {
    const count = remaining.get(line) ?? 0;
    if (count) remaining.set(line, count - 1);
    else added.push(line);
  }
  return added;
}

function derivedForPath(path: string, files: readonly DerivedFile[]): DerivedFile[] {
  return files.filter((file) => matchesPath(path, [file.path]));
}

function markdownUnionFiles(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return [
    ...new Set(
      readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .flatMap(
          (line) =>
            line.match(/^Rebase resolved mechanical conflicts: .*; Markdown union: (.+)$/)?.[1]?.split(', ') ?? [],
        ),
    ),
  ];
}

function changedWorkingFiles(cwd: string): string[] {
  const tracked = spawnSync('git', ['diff', '--name-only', '-z', 'HEAD', '--'], { cwd, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  if (tracked.status !== 0 || untracked.status !== 0) throw new Error('Cannot read generated file changes');
  return [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))];
}

/** Refresh promotion outputs on a dev landing when its source changes require them. */
/**
 * Derived generators need the workspace's dependencies (the pinned bun, dbmate for migrations), but a train worktree is
 * created with nothing installed: every landing that regenerated derived files failed with ENOENT on
 * node_modules/.bin/bun or services/kernel/node_modules/.bin/dbmate (2026-10-29). Install once before the first command.
 */
function ensureDerivedDependencies(cwd: string, logPath: string, commands: Iterable<readonly string[]>): void {
  // A lockfile regeneration is itself the install.
  if ([...commands].every((command) => command[0] === 'bun' && command[1] === 'install')) return;
  // Only a repository with a lockfile installs; fixtures and trees with dependencies already present do not.
  if (!existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'node_modules', '.bin'))) return;
  const result = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd, encoding: 'utf8' });
  appendFileSync(
    logPath,
    `$ bun install --frozen-lockfile (cwd: ${cwd})\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
  if (result.status !== 0)
    throw new Error(`Failed to install dependencies for derived files: ${result.stderr || 'bun install failed'}`);
}

function regenerateLandingDerivedFiles(
  cwd: string,
  base: string,
  files: readonly DerivedFile[],
  logPath: string,
): void {
  const changedSources = changedPathsBetween(cwd, base, git(cwd, 'rev-parse', 'HEAD'));
  const triggered = files.filter(
    (file) =>
      file.stage === 'promotion' &&
      file.inputs?.length &&
      changedSources.some((path) => matchesPath(path, file.inputs!)),
  );
  if (!triggered.length) return;

  const commands = new Map<string, string[]>();
  for (const file of triggered) commands.set(JSON.stringify(file.command), file.command);
  ensureDerivedDependencies(cwd, logPath, commands.values());
  for (const command of commands.values()) {
    const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n${output}`);
    if (result.status !== 0)
      throw new Error(`Failed to regenerate derived files: ${output || result.error?.message || 'command failed'}`);
  }

  const changed = changedWorkingFiles(cwd);
  const outside = changed.filter((path) => !files.some((file) => matchesPath(path, [file.path])));
  if (outside.length) throw new Error(`Derived generator changed non-derived files: ${outside.join(', ')}`);
  if (!changed.length) {
    appendFileSync(logPath, 'Derived outputs already match the dev landing; no regeneration commit added\n');
    return;
  }
  stagePaths(cwd, changed);
  git(cwd, 'commit', '--amend', '--no-edit');
}

/** A path gone from both the index and the worktree is an already staged deletion, and naming it fails `git add`. */
export function stagePaths(cwd: string, paths: Iterable<string>): void {
  const all = [...paths];
  if (!all.length) return;
  const indexed = new Set(git(cwd, 'ls-files', '-z', '--', ...all).split('\0'));
  const present = all.filter((path) => indexed.has(path) || existsSync(join(cwd, path)));
  if (present.length) git(cwd, 'add', '-A', '--', ...present);
}

function unmergedFiles(cwd: string): string[] {
  return git(cwd, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
}

type FrozenTaskRecord = { frozenFiles?: { path: string; hash: string }[] };
function frozenFilesForTask(stateDirectory: string, taskId: string): { path: string; hash: string }[] {
  const path = join(stateDirectory, 'goal.sqlite');
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const row = db.query('SELECT body FROM worker_tasks WHERE id=?').get(taskId) as { body: string } | null;
    return row ? ((JSON.parse(row.body) as FrozenTaskRecord).frozenFiles ?? []) : [];
  } finally {
    db.close();
  }
}

function localBranchSettings(mainCheckout: string): { stabilizeBranch?: string; supermanager?: string } {
  const file = process.env.GOAL_LOCAL_CONFIG
    ? resolve(process.env.GOAL_LOCAL_CONFIG)
    : join(mainCheckout, '.temp/goal/local.json');
  if (!existsSync(file)) return {};
  try {
    const local = JSON.parse(readFileSync(file, 'utf8')) as {
      stabilizeBranch?: unknown;
      integration?: { supermanager?: unknown };
    };
    const stabilizeBranch = typeof local.stabilizeBranch === 'string' ? local.stabilizeBranch.trim() : '';
    const supermanager =
      typeof local.integration?.supermanager === 'string' ? local.integration.supermanager.trim() : '';
    return {
      ...(stabilizeBranch ? { stabilizeBranch } : {}),
      ...(supermanager ? { supermanager } : {}),
    };
  } catch {
    return {};
  }
}

function taskIntegrationTarget(
  stateDirectory: string,
  taskId: string,
): { target?: string; manager?: string; goal?: string; base?: string; workspace?: Task['workspace'] } {
  const path = join(stateDirectory, 'goal.sqlite');
  if (!existsSync(path)) return {};
  const db = new Database(path, { readonly: true, strict: true });
  db.exec('PRAGMA busy_timeout = 30000');
  try {
    const row = db.query('SELECT body FROM worker_tasks WHERE id=?').get(taskId) as { body: string } | null;
    if (!row) return {};
    const task = JSON.parse(row.body) as {
      base?: unknown;
      workspace?: Task['workspace'];
      brief?: { target?: unknown; manager?: unknown; goal?: unknown };
    };
    const brief = task.brief;
    return {
      ...(task.workspace ? { workspace: task.workspace } : {}),
      ...(typeof brief?.target === 'string' ? { target: brief.target } : {}),
      ...(typeof brief?.manager === 'string' ? { manager: brief.manager } : {}),
      ...(typeof brief?.goal === 'string' ? { goal: brief.goal } : {}),
      ...(typeof task.base === 'string' ? { base: task.base } : {}),
    };
  } finally {
    db.close();
  }
}

const CONTROL_PLANE_PATH = 'tools/goal/';
// A train worktree lies outside the main checkout with nothing installed: the first control-plane landing on main
// failed its typecheck with exit 127. The root tests' preloads need the root packages, tsc needs tools/goal's own.
export const CONTROL_PLANE_CHECKS: readonly (readonly string[])[] = [
  ['bun', 'install', '--frozen-lockfile'],
  ['bun', 'install', '--frozen-lockfile', '--cwd', 'tools/goal'],
  ['bun', 'run', '--cwd', 'tools/goal', 'typecheck'],
  // Under check-host load (60-75 on 2026-10-29) git-heavy tests took over bun's 5 s default and refused unrelated
  // landings; 30 s per test keeps a real hang visible.
  ['bun', 'test', '--timeout', '30000', 'tools/goal/src'],
];
const LAUNCH_SMOKE_PATHS = defaults.launchSmokePaths as string[];
export function launchSmokeRequired(changed: readonly string[]): boolean {
  return changed.some((path) => matchesPath(path, LAUNCH_SMOKE_PATHS));
}

type ControlPlaneReleaseSnapshot = {
  mainBranch: string;
  mainHead: string;
  stabilizeBranch: string;
  stabilizeHead?: string;
  devBranch: string;
  devHead: string;
};

type ControlPlaneReleaseRecord = {
  version: 1;
  taskId: string;
  attempt: number;
  mainBranch: string;
  mainCommit: string;
  mainExpected: string;
  source?: { branch: string; commit: string };
  devBranch: string;
  devScriptTree: string;
  devCommit: string;
  stabilizeBranch: string;
  stabilizeExpected?: string;
  stabilizeCommit?: string;
  lifecycleEvidence: string;
  compatibilityCommand: string[];
  recordedAt: string;
  batchId?: string;
  scopeApprovals?: Record<string, string | null>;
  members?: {
    entryId: number;
    request: LandingRequest;
    outcome: GateOutcome;
    disposition: ControlPlaneBatchDisposition;
  }[];
};

type PreparedControlPlaneRelease = {
  snapshot: ControlPlaneReleaseSnapshot;
  record: ControlPlaneReleaseRecord;
};

type ControlPlaneProof = GateResult & {
  failedCommand?: readonly string[];
  moved?: boolean;
  negativeOnly?: boolean;
  lifecycleEvidence?: string;
  compatibilityCommand?: string[];
};
type CompletedControlPlaneProof = {
  candidate: string;
  snapshot: ControlPlaneReleaseSnapshot;
  sources: ControlPlaneBatchManifest['members'];
  result: ControlPlaneProof;
  completedAt: string;
  scopeApprovals?: Record<string, string | null>;
};
type ControlPlaneBatchNode = {
  indices: number[];
  attempts: number;
  logPath: string;
  children?: string[];
  failure?: string;
  prepared?: PreparedControlPlaneRelease;
  completed?: boolean;
  /** Persisted before any native evidence can be produced for these members. */
  nativeMembers?: number[];
  proofs?: CompletedControlPlaneProof[];
  /** A passing probe is never release evidence. Only full proof can prepare a release. */
  negativeProbes?: string[][];
};
type ControlPlaneBatchJournal = {
  version: 1;
  batchId: string;
  manifest: ControlPlaneBatchManifest;
  nodes: Record<string, ControlPlaneBatchNode>;
  results: ControlPlaneBatchDisposition[];
  identities?: Record<string, string>;
  scopeApprovals?: Record<string, ControlPlaneScopeApprovalReceipt | null>;
  controller?: ProcessIdentity;
  superseded?: ControlPlaneBatchSupersessionResult;
  refContinuation?: { receiptId: string; controller: ProcessIdentity };
};

type ControlPlaneRefContinuationReceipt = {
  id: string;
  input: ControlPlaneBatchRefContinuation;
  actor: { managerId: string; sessionId: string };
  previousJournal: string;
  previousController: ProcessIdentity;
  controller: ProcessIdentity;
  receivedAt: string;
};
const refContinuationNode = 'ref-continuation';

/** Same ordinary dev lease, bounded like lifecycle waits, without blocking the current train's event loop. */
export async function acquireControlPlaneDevLane(stateDirectory: string, timeoutMs = 30_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
    throw new Error('Control-plane dev lease wait must be within 30 seconds');
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      return acquireDirectoryLease(join(stateDirectory, 'train.lease'));
    } catch (error) {
      if (!(error instanceof LeaseHeldError)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new LeaseHeldError(`Dev train lease held after waiting ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
  }
}

function controlPlaneBriefHash(markdown: string): string {
  return createHash('sha256').update(markdown.replace(/\r\n?/g, '\n').trimEnd()).digest('hex');
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd }).status === 0;
}

export function changedPathsBetween(cwd: string, base: string, head: string): string[] {
  const changed = spawnSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head, '--'], {
    cwd,
    encoding: 'utf8',
  });
  if (changed.status !== 0)
    throw new Error(changed.stderr?.trim() || changed.error?.message || 'Cannot read task changes');
  return changed.stdout.split('\0').filter(Boolean);
}

function pathsChangedByTaskButUnchangedOnDev(
  cwd: string,
  dev: string,
  candidate: string,
  taskTip: string,
  taskPaths: readonly string[],
): string[] {
  const compare = (left: string, right: string, path: string): boolean => {
    const result = spawnSync('git', ['diff', '--quiet', left, right, '--', path], { cwd });
    if (result.status === null || result.status > 1)
      throw new Error(result.stderr?.toString().trim() || result.error?.message || `Cannot compare ${path}`);
    return result.status === 1;
  };
  return taskPaths.filter((path) => compare(dev, taskTip, path) && !compare(dev, candidate, path));
}

function refuseNoEffect(
  result: GateOutcome,
  paths: readonly string[],
  logPath: string,
  reason = `Change had no effect on dev: ${paths.join(', ')}`,
): void {
  result.stage = 'merge';
  result.conflictedFiles = [...paths];
  result.firstFailure = firstFailure(reason);
  appendFileSync(logPath, `${reason}\n`);
}

function refuseFrozenAcceptanceChange(result: GateOutcome, paths: readonly string[], logPath: string): void {
  const canonical = canonicalConflictPaths(paths);
  result.stage = 'rebase';
  result.refusal = { kind: 'frozen-acceptance-change', paths: canonical };
  result.firstFailure = firstFailure(`Frozen acceptance file changed: ${canonical.join(', ')}`);
  appendFileSync(logPath, `Frozen acceptance files changed: ${canonical.join(', ')}\n`);
}

function treeDiffIsEmpty(cwd: string, base: string, candidate: string): boolean {
  const result = spawnSync('git', ['diff', '--quiet', base, candidate, '--'], { cwd });
  if (result.status === null || result.status > 1)
    throw new Error(result.stderr?.toString().trim() || result.error?.message || 'Cannot compare landing trees');
  return result.status === 0;
}

class WorkerConflictError extends Error {
  constructor(
    readonly path: string,
    readonly detail = '',
  ) {
    super(`Worker change conflicts with dev in ${path}${detail ? `: ${detail}` : ''}`);
  }
}

/** Inspect the actual diff: an unchanged duplicate is not an addition, while a moved line is. */
function assertTaskDeletionsAbsent(cwd: string, file: string, base: string, task: string, result: string): void {
  mkdirSync(join(cwd, '.temp'), { recursive: true });
  const scratch = mkdtempSync(join(cwd, '.temp', 'union-deletions-'));
  try {
    const basePath = join(scratch, 'base');
    const taskPath = join(scratch, 'task');
    writeFileSync(basePath, base);
    writeFileSync(taskPath, task);
    const diff = spawnSync(
      'git',
      ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '--', basePath, taskPath],
      { cwd, encoding: 'utf8' },
    );
    if (diff.status !== 0 && diff.status !== 1)
      throw new Error(diff.stderr.trim() || `Cannot read task diff for ${file}`);
    const deleted = new Set<string>();
    const added = new Set<string>();
    let inHunk = false;
    for (const line of diff.stdout.split(/\r?\n/)) {
      if (line.startsWith('@@')) inHunk = true;
      else if (inHunk && line.startsWith('-')) deleted.add(line.slice(1));
      else if (inHunk && line.startsWith('+')) added.add(line.slice(1));
    }
    const remaining = new Set(result.split(/\r?\n/));
    const conflicts = [...deleted].filter((line) => !added.has(line) && remaining.has(line));
    if (conflicts.length)
      throw new WorkerConflictError(
        file,
        `task-deleted lines remain: ${conflicts.map((line) => JSON.stringify(line)).join(', ')}`,
      );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function changedFrozenFiles(cwd: string, frozen: readonly { path: string; hash: string }[]): string[] {
  return frozen
    .filter((file) => {
      try {
        return (
          createHash('sha256')
            .update(readFileSync(join(cwd, file.path)))
            .digest('hex') !== file.hash
        );
      } catch {
        return true;
      }
    })
    .map((file) => file.path);
}

function frozenFilesModifiedAtCommit(
  cwd: string,
  commit: string,
  frozen: readonly { path: string; hash: string }[],
): string[] {
  const verified = spawnSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
    cwd,
    encoding: 'utf8',
  });
  if (verified.error || verified.status !== 0)
    throw new Error(verified.stderr?.trim() || verified.error?.message || `Cannot read target commit ${commit}`);

  return frozen
    .filter((file) => {
      const exists = spawnSync('git', ['cat-file', '-e', `${commit}:${file.path}`], { cwd });
      if (exists.error) throw new Error(exists.error.message);
      // A missing frozen path is a worker-only addition for legacy diagnostics, not a target edit.
      if (exists.status !== 0) return false;
      const blob = spawnSync('git', ['cat-file', 'blob', `${commit}:${file.path}`], {
        cwd,
        encoding: 'buffer',
      });
      if (blob.error || blob.status !== 0)
        throw new Error(
          blob.stderr?.toString().trim() || blob.error?.message || `Cannot read frozen path ${file.path}`,
        );
      return createHash('sha256').update(blob.stdout).digest('hex') !== file.hash;
    })
    .map((file) => file.path);
}

/**
 * Resolve import-only hunks in code and union Markdown conflicts for review after the ordinary landing checks.
 * Returns false, leaving every file for a person, when any file holds another kind of conflict.
 */
export function resolveMechanicalConflicts(
  cwd: string,
  paths: readonly string[],
  formatCommand?: readonly string[],
  markdown: 'insertions' | 'union' = 'insertions',
  // Index stage holding the task; callers replaying it during a rebase must select stage 3.
  taskStage: 2 | 3 = 2,
): string[] | false {
  const resolved = new Map<string, string>();
  const unionResolved: string[] = [];
  for (const file of paths) {
    const path = join(cwd, file);
    if (!existsSync(path)) return false;
    let text: string | undefined;
    if (file.endsWith('.md')) {
      const stages = ([1, 2, 3] as const).map((stage) => {
        const result = spawnSync('git', ['show', `:${stage}:${file}`], { cwd, encoding: 'utf8' });
        if (stage === 1 && result.status !== 0) return '';
        if (result.status !== 0) throw new Error(`Cannot read conflict stage ${stage} for ${file}`);
        return result.stdout;
      });
      mkdirSync(join(cwd, '.temp'), { recursive: true });
      const scratch = mkdtempSync(join(cwd, '.temp', 'markdown-union-'));
      try {
        const [base, ours, theirs] = stages;
        const basePath = join(scratch, 'base');
        const oursPath = join(scratch, 'ours');
        const theirsPath = join(scratch, 'theirs');
        writeFileSync(basePath, base!);
        writeFileSync(oursPath, ours!);
        writeFileSync(theirsPath, theirs!);
        // Stabilize-to-dev merges retain their existing insertion-only policy. Rebases explicitly request union.
        if (markdown === 'insertions') {
          const analysis = spawnSync('git', ['merge-file', '--diff3', '-p', oursPath, basePath, theirsPath], {
            cwd,
            encoding: 'utf8',
          });
          const bases = [...analysis.stdout.matchAll(/^\|{7} [^\n]*\n([\s\S]*?)^=======$/gm)];
          const conflicts = [...analysis.stdout.matchAll(/^<{7} /gm)].length;
          if (
            analysis.status === null ||
            analysis.status < 1 ||
            analysis.status > 127 ||
            !conflicts ||
            bases.length !== conflicts ||
            bases.some((match) => match[1]!.trim().length > 0)
          )
            return false;
        }
        const merged = spawnSync('git', ['merge-file', '--union', '-p', oursPath, basePath, theirsPath], {
          cwd,
          encoding: 'utf8',
        });
        // `--union` writes both sides' conflicting lines but still exits 1 to report that the inputs overlapped.
        // Treat that expected conflict status as a successful resolution; higher statuses indicate a tool error.
        if (merged.status === null || merged.status > 1) return false;
        // Preserve Markdown heading separators until the landing's ordinary formatter runs.
        text = merged.stdout.replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2');
        if (markdown === 'union') assertTaskDeletionsAbsent(cwd, file, base!, stages[taskStage - 1]!, text);
        if (markdown === 'union' && text === ours && theirs !== ours && theirs !== base)
          throw new WorkerConflictError(file);
        unionResolved.push(file);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    } else if (matchesPath(file, defaultJsonMessageConflicts)) {
      const stages = ([1, 2, 3] as const).map((stage) => {
        const result = spawnSync('git', ['show', `:${stage}:${file}`], { cwd, encoding: 'utf8' });
        if (stage === 1 && result.status !== 0) return '{}';
        if (result.status !== 0) throw new Error(`Cannot read conflict stage ${stage} for ${file}`);
        return result.stdout;
      });
      const merged = mergeFlatJsonMessage(stages[0]!, stages[1]!, stages[2]!);
      if (!merged.ok) return false;
      const ours = parseFlatJsonObject(stages[1]!);
      const theirs = parseFlatJsonObject(stages[2]!);
      const base = parseFlatJsonObject(stages[0]!);
      text = `${JSON.stringify(merged.value, null, 2)}\n`;
      assertTaskDeletionsAbsent(cwd, file, stages[0]!, stages[taskStage - 1]!, text);
      if (
        ours &&
        theirs &&
        base &&
        comparableJson(merged.value) === comparableJson(ours) &&
        comparableJson(theirs) !== comparableJson(ours) &&
        comparableJson(theirs) !== comparableJson(base)
      )
        throw new WorkerConflictError(file);
    } else if (/\.[cm]?[jt]sx?$/.test(file)) text = resolveImportConflicts(readFileSync(path, 'utf8'));
    if (text === undefined) return false;
    resolved.set(path, text);
  }
  for (const [path, text] of resolved) writeFileSync(path, text);
  const format = formatCommand ?? [join(cwd, 'node_modules/.bin/oxfmt'), ...FORMAT_FLAGS];
  if (!format[0]!.endsWith('/node_modules/.bin/oxfmt') || existsSync(format[0]!))
    spawnSync(format[0]!, [...format.slice(1), ...paths], { cwd, encoding: 'utf8' });
  return unionResolved;
}

type JsonObject = Record<string, unknown>;
type JsonMergeResult = { ok: true; value: JsonObject } | { ok: false; key: string };

function parseFlatJsonObject(text: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as JsonObject;
  } catch {
    return undefined;
  }
}

function comparableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(comparableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${comparableJson((value as JsonObject)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Three-way merge flat message catalogs, retaining ours' catalog order and appending theirs' new keys. */
function mergeFlatJsonMessage(baseText: string, oursText: string, theirsText: string): JsonMergeResult {
  const base = parseFlatJsonObject(baseText);
  const ours = parseFlatJsonObject(oursText);
  const theirs = parseFlatJsonObject(theirsText);
  if (!base || !ours || !theirs) return { ok: false, key: '<invalid JSON catalog>' };
  const absent = Symbol('absent');
  const equal = (left: unknown | typeof absent, right: unknown | typeof absent) =>
    left === absent || right === absent ? left === right : comparableJson(left) === comparableJson(right);
  const keys = [...Object.keys(ours), ...Object.keys(theirs).filter((key) => !(key in ours))];
  const value: JsonObject = {};
  for (const key of keys) {
    const b = Object.hasOwn(base, key) ? base[key] : absent;
    const o = Object.hasOwn(ours, key) ? ours[key] : absent;
    const t = Object.hasOwn(theirs, key) ? theirs[key] : absent;
    const chosen = equal(o, t) ? o : equal(o, b) ? t : equal(t, b) ? o : undefined;
    if (chosen === undefined && !equal(o, b) && !equal(t, b)) return { ok: false, key };
    if (chosen !== absent && chosen !== undefined) value[key] = chosen;
  }
  return { ok: true, value };
}

function jsonMessageConflictError(cwd: string, paths: readonly string[]): Error | undefined {
  for (const file of paths.filter((path) => matchesPath(path, defaultJsonMessageConflicts))) {
    const stages = ([1, 2, 3] as const).map((stage) => {
      const result = spawnSync('git', ['show', `:${stage}:${file}`], { cwd, encoding: 'utf8' });
      return result.status === 0 ? result.stdout : '{}';
    });
    const result = mergeFlatJsonMessage(stages[0]!, stages[1]!, stages[2]!);
    if (!result.ok) return new Error(`JSON message conflict in ${file}: key ${result.key}`);
  }
  return undefined;
}

function rebaseWithDerivedFiles(
  cwd: string,
  base: string,
  originalBase: string,
  logPath: string,
  files: readonly DerivedFile[],
): unknown | boolean {
  try {
    git(cwd, '-c', 'rebase.updateRefs=false', 'rebase', '--onto', base, originalBase);
    return false;
  } catch (initialError) {
    let rebaseError: unknown = initialError;
    for (;;) {
      const conflicts = unmergedFiles(cwd);
      if (!conflicts.length) throw rebaseError;
      // bun.lock is an integration-stage derived file: keep the integration lockfile, regenerate from the
      // merged manifests, and commit that result as part of the rebased landing.
      const derivedConflicts = conflicts.filter((path) => derivedForPath(path, files).length > 0);
      const textConflicts = conflicts.filter((path) => !derivedForPath(path, files).length);
      // Validate all ordinary conflicts before choosing a generated side or running a generator.
      if (textConflicts.length) {
        const unionResolved = resolveMechanicalConflicts(cwd, textConflicts, undefined, 'union', 3);
        if (!unionResolved) return jsonMessageConflictError(cwd, textConflicts) ?? rebaseError;
        const markdownUnion = unionResolved.length ? `; Markdown union: ${unionResolved.join(', ')}` : '';
        appendFileSync(logPath, `Rebase resolved mechanical conflicts: ${textConflicts.join(', ')}${markdownUnion}\n`);
        stagePaths(cwd, new Set(textConflicts));
      }

      for (const path of derivedConflicts) git(cwd, 'checkout', '--ours', '--', path);
      const integrationCommands = new Map<string, string[]>();
      for (const path of derivedConflicts)
        for (const file of derivedForPath(path, files)) {
          integrationCommands.set(JSON.stringify(file.command), file.command);
        }
      if (integrationCommands.size) ensureDerivedDependencies(cwd, logPath, integrationCommands.values());
      for (const command of integrationCommands.values()) {
        const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: 'utf8' });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n${output}`);
        if (result.status !== 0)
          throw new Error(`Failed to regenerate derived files: ${output || result.error?.message || 'command failed'}`);
      }
      const regeneratedLockfile = derivedConflicts.includes('bun.lock');
      const stageFiles = new Set(derivedConflicts);
      for (const path of changedWorkingFiles(cwd)) if (derivedForPath(path, files).length) stageFiles.add(path);
      stagePaths(cwd, stageFiles);
      try {
        git(cwd, '-c', 'core.editor=true', 'rebase', '--continue');
        return regeneratedLockfile;
      } catch (continueError) {
        if (!unmergedFiles(cwd).length) throw continueError;
        rebaseError = continueError;
      }
    }
  }
}

/**
 * The commit the branch's own work starts from. A recorded base the branch has already moved past, or one it does not
 * descend from, would replay or squash other work: a squash from such a base once reverted hundreds of files.
 */
export function rebaseUpstream(cwd: string, base: string, originalBase: string): string {
  const fork = git(cwd, 'merge-base', 'HEAD', base);
  const ancestor = (older: string, newer: string) =>
    spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd }).status === 0;
  return ancestor(originalBase, 'HEAD') && ancestor(fork, originalBase) ? originalBase : fork;
}

export function rebaseOnto(
  cwd: string,
  base: string,
  originalBase: string,
  logPath: string,
  files: readonly DerivedFile[] = defaultDerivedFiles,
  allowedPaths?: readonly string[],
): boolean {
  const upstream = rebaseUpstream(cwd, base, originalBase);
  const head = git(cwd, 'rev-parse', 'HEAD');
  // Files the worker's own commits touched: a squash may change these outside the allowed paths, never a file only
  // the target's history changed, which a wrong upstream would replay or revert.
  const own = new Set(git(cwd, 'log', '--name-only', '--format=', `${base}..${head}`).split('\n').filter(Boolean));
  const originalSubjects = git(cwd, 'log', '--format=%s', '--reverse', `${upstream}..HEAD`).split('\n').filter(Boolean);
  const initialConflict = rebaseWithDerivedFiles(cwd, base, upstream, logPath, files);
  if (typeof initialConflict === 'boolean') return initialConflict;

  git(cwd, 'rebase', '--abort');
  git(cwd, 'reset', '--soft', upstream);
  const message = [
    'Squash worker branch changes',
    '',
    'Original commits:',
    ...originalSubjects.map((subject) => `- ${subject}`),
  ].join('\n');
  git(cwd, 'commit', '--allow-empty', '-m', message);
  if (allowedPaths) {
    const changed = git(cwd, 'diff', '--name-only', upstream, 'HEAD').split('\n').filter(Boolean);
    const outside = outsideScope(
      changed.filter((path) => !derivedForPath(path, files).length && !own.has(path)),
      allowedPaths,
    );
    if (outside.length) {
      git(cwd, 'reset', '--hard', head);
      throw new Error(`A squash would change files outside the brief: ${outside.slice(0, 20).join(', ')}`);
    }
  }

  const squashedConflict = rebaseWithDerivedFiles(cwd, base, upstream, logPath, files);
  if (squashedConflict !== undefined && typeof squashedConflict !== 'boolean') throw squashedConflict;
  return squashedConflict === true;
}

export type TrainOptions = {
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  formatCommand?: string[];
  riskAreasFile?: string;
  affectedTests?: import('./types.ts').AffectedTestCheck[];
  /** The mandatory direct root typecheck used before a dev ref advance. */
  runTypecheck?: GateRunner;
  /** Checks for landings into dev; a function is called for every landing, so a configuration change applies at once. */
  integrationChecks?: IntegrationCheck[] | (() => IntegrationCheck[]);
  /** Batched dev landings; absent integration settings retain one-at-a-time behavior. */
  integration?: {
    batchSize?: number;
    batchAcceptanceConcurrency?: number;
    devLandingChecks?: boolean;
    devPrelandingTypecheck?: boolean;
    gateTimeoutMs?: number;
  };
  queue: SqliteLandingQueue;
  fence: AttemptFence;
  sink: GateOutcomeSink;
  derivedFiles?: DerivedFile[];
  runGate?: GateRunner;
  /** Mandatory control-plane proof uses a fresh runner, without reusable-result shortcuts. */
  runControlPlaneGate?: GateRunner;
  /** Candidate Git seam used for integrity checks and prepared control-plane merges. */
  runCandidateGit?: CandidateGitRunner;
  /** The delivered bounded resolver; production supplies the configured task/pool runtime. */
  trainResolver?: TrainResolver;
  /** Real launch smoke seam; production uses the bounded candidate smoke after control-plane checks. */
  runLaunchSmoke?: GateRunner;
  /** Ordinary main releases wait asynchronously for dev, then defer. Bounded to at most 30 seconds. */
  controlPlaneDevLeaseTimeoutMs?: number;
  gateIdentity?: string;
  mainBranch?: string;
  integrationBranch?: string;
  /** Branch that receives `target: stabilize` tasks. Defaults to `stabilize`. */
  stabilizeBranch?: string;
  supermanager?: string;
  inboxDirectory?: string;
  codeIsCurrent?: () => boolean;
  handOff?: () => void | Promise<void>;
  /** Runs after the landing lease is released, in the same process that drained the queue. */
  promote?: () => Promise<void>;
  /** Test seams around the final synchronous Git operation and train shutdown. */
  merge?: (cwd: string, candidate: string) => void;
  beforeRelease?: () => Promise<void>;
  beforeIntegrationAdvance?: () => void;
  beforePromotionAdvance?: () => void;
};

type PreparedLanding = {
  entry: LandingEntry;
  result: GateOutcome;
  base: string;
  candidate: string;
  commits: string[];
  started: number;
};
type BatchLandingResult = {
  outcomes: { entry: LandingEntry; outcome: GateOutcome }[];
  deferredIds: number[];
  skippedIds: number[];
};

class ControlPlaneProofInterrupted extends Error {}

type OrdinaryProofAttempt = {
  source: string;
  snapshot: ControlPlaneReleaseSnapshot;
  logPath: string;
  status: 'running' | 'interrupted' | 'finished';
  outcome?: GateOutcome;
  candidate?: string;
  validations?: number;
  reason?: string;
};

type OrdinaryProofCustody = {
  signal: AbortSignal;
  checkpoint(): void;
  run(runner: GateRunner): GateRunner;
  logPath: string;
  capture(candidate: string, snapshot: ControlPlaneReleaseSnapshot): void;
};

type SpawnTextResult = {
  status: number | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error;
};
type SpawnText = (command: string, args: string[], options: { cwd: string; encoding: 'utf8' }) => SpawnTextResult;

export class MergeTrain {
  private readonly workspaceFailures = new Map<number, GateOutcome[]>();
  constructor(private readonly options: TrainOptions) {}

  private async checkDevCandidate(
    tree: string,
    base: string,
    candidate: string,
    logPath: string,
  ): Promise<{ command: string[]; result: GateResult }> {
    const command = rootTypecheckCommand(changedFiles(tree, base));
    // With devPrelandingTypecheck off, dev lands without a compiler run; the verifier checks dev after the merge.
    if (this.options.integration?.devPrelandingTypecheck === false) {
      appendFileSync(
        logPath,
        'Prelanding typecheck skipped (devPrelandingTypecheck off); dev is verified after the merge\n',
      );
      return { command, result: { passed: true, output: '', timedOut: false } };
    }
    const run =
      this.options.runTypecheck ??
      this.options.runGate ??
      processGroupRunner(this.options.integration?.gateTimeoutMs, this.options.stateDirectory, process.env);
    for (let attempt = 0; attempt < 2; attempt++) {
      appendFileSync(logPath, `$ ${command.join(' ')} (required root typecheck on ${candidate}, dev ${base})\n`);
      let result: GateResult;
      try {
        result = await run(command, tree, logPath);
      } catch (error) {
        result = {
          passed: false,
          output: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          timedOut: false,
        };
      }
      assertCandidateIntegrity(tree, candidate, 'dev root typecheck', logPath, this.options.runCandidateGit);
      if (!compilerInfrastructureFailure(result.output, result.timedOut) || attempt === 1) return { command, result };
      appendFileSync(logPath, 'Root typecheck infrastructure failure; retrying once on the same candidate\n');
    }
    throw new Error('Unreachable root typecheck retry state');
  }

  async run(): Promise<void> {
    await this.drainBoth(true);
  }

  /**
   * A detached train runs only if it can take the lease. Every settle spawns one, so waiting for the owner made them
   * pile up: 304 trains polling every 50 ms took the host to load 111. The owner drains the queue and checks its code
   * version before each request, and the host's sweep starts a train for any request left behind.
   */
  async runWaiting(): Promise<void> {
    await this.drainBoth(false);
  }

  /** Background pumps are best-effort: a current lease owner will see any request queued during shutdown. */
  async pump(): Promise<void> {
    await this.drainBoth(false);
  }

  private async drainBoth(failWhenInitiallyHeld: boolean): Promise<void> {
    let handOff: Promise<void> | undefined;
    const handOffOnce = () => {
      handOff ??= Promise.resolve(this.options.handOff?.());
      return handOff;
    };
    const start = (lane: 'main' | 'dev') =>
      new Promise<void>((resolve, reject) => {
        setTimeout(() => this.drain(lane, failWhenInitiallyHeld, handOffOnce).then(resolve, reject), 0);
      });
    // Start dev first: a strict run must not mistake its own main release's dev lease for another train.
    // Once dev has acquired its lane, later contention already uses the normal quiet return path.
    await Promise.all([start('dev'), start('main')]);
  }

  private async drain(
    lane: 'main' | 'dev',
    failWhenInitiallyHeld: boolean,
    handOff: () => Promise<void>,
  ): Promise<void> {
    const o = this.options;
    mkdirSync(o.stateDirectory, { recursive: true });
    const leasePath = join(o.stateDirectory, lane === 'main' ? 'train-main.lease' : 'train.lease');
    let acquired = false;
    const retryDeferred = new Set<number>();
    for (;;) {
      // Check immediately before every acquisition attempt. A process that turns stale while queued must
      // leave the request for a fresh train instead of briefly taking the lease to discover that fact.
      if (o.codeIsCurrent && !o.codeIsCurrent()) {
        await handOff();
        return;
      }
      let lease: ReturnType<typeof acquireDirectoryLease>;
      try {
        lease = acquireDirectoryLease(leasePath);
      } catch (error) {
        if (error instanceof LeaseHeldError) {
          if (failWhenInitiallyHeld && !acquired) throw error;
          return;
        }
        throw error;
      }
      acquired = true;
      const roundHead = this.integrationHead();
      const deferred = new Set<number>();
      let processedEntry = false;
      try {
        if (o.codeIsCurrent && !o.codeIsCurrent()) {
          await handOff();
          return;
        }
        for (;;) {
          if (o.codeIsCurrent && !o.codeIsCurrent()) {
            await handOff();
            return;
          }
          const entry = o.queue.nextBatch(1, [...deferred], lane)[0];
          if (!entry) break;
          processedEntry = true;
          try {
            if (entry.outcome) {
              o.sink.onGateOutcome(entry.outcome);
              o.queue.acknowledge(entry.id);
              retryDeferred.delete(entry.id);
              continue;
            }
            o.fence.assertCurrent(entry.request);
            const batchSize = o.integration?.batchSize ?? 1;
            const batch: LandingEntry[] = [];
            const scanned = new Set<number>([entry.id]);
            if (this.canBatch(entry)) batch.push(entry);
            while (batch.length < batchSize && batch.length > 0) {
              const candidate = o.queue.nextBatch(1, [...deferred, ...scanned], lane)[0];
              if (!candidate) break;
              scanned.add(candidate.id);
              if (candidate.outcome || !this.canBatch(candidate)) continue;
              try {
                o.fence.assertCurrent(candidate.request);
              } catch (error) {
                if (!(error instanceof StaleAttemptError)) throw error;
                o.queue.acknowledge(candidate.id);
                retryDeferred.delete(candidate.id);
                continue;
              }
              batch.push(candidate);
            }
            if (batch.length > 1 || (batch.length === 1 && retryDeferred.has(batch[0]!.id))) {
              const integrated = await this.integrateBatch(batch);
              for (const id of integrated.skippedIds) {
                o.queue.acknowledge(id);
                retryDeferred.delete(id);
              }
              for (const id of integrated.deferredIds) {
                deferred.add(id);
                retryDeferred.add(id);
              }
              for (const { entry: member, outcome } of integrated.outcomes) {
                try {
                  o.queue.finish(member.id, outcome);
                  o.sink.onGateOutcome(outcome);
                  o.queue.acknowledge(member.id);
                  retryDeferred.delete(member.id);
                } catch (error) {
                  if (!(error instanceof StaleAttemptError)) throw error;
                  o.queue.acknowledge(member.id);
                  retryDeferred.delete(member.id);
                }
              }
            } else {
              const outcome = await this.integrateOrdinary(entry, lane, handOff);
              if (!outcome) {
                // Leave the request pending for the next pump, without retrying contention in this drain.
                if (o.codeIsCurrent && !o.codeIsCurrent()) await handOff();
                return;
              }
              const workspaceFailures = this.workspaceFailures.get(entry.id);
              this.workspaceFailures.delete(entry.id);
              if (workspaceFailures) {
                for (const failure of workspaceFailures) {
                  if (failure.taskId === entry.request.taskId) continue;
                  const store = o.fence as WorkerStore;
                  try {
                    store.assertCurrent(failure);
                  } catch (error) {
                    if (error instanceof StaleAttemptError) continue;
                    throw error;
                  }
                  if (store.record(failure)) o.sink.onGateOutcome(failure);
                  else {
                    const task = store.task(failure.taskId);
                    new SqliteManagerInbox(store.db, o.inboxDirectory ?? join(o.stateDirectory, 'inboxes')).deliver({
                      managerId: task.brief.manager,
                      taskId: task.id,
                      kind: 'instruction',
                      summary:
                        `Shared workspace landing failed in your work: ${failure.firstFailure?.assertion ?? failure.stage}. See ${failure.logPath}`.replace(
                          /[\r\n]+/g,
                          ' ',
                        ),
                    });
                  }
                }
                if (!workspaceFailures.some((failure) => failure.taskId === entry.request.taskId)) {
                  deferred.add(entry.id);
                  continue;
                }
              }

              o.queue.finish(entry.id, outcome);
              // Sink delivery is at least once; obsolete entries must never block the current attempt.
              o.sink.onGateOutcome(outcome);
              o.queue.acknowledge(entry.id);
              retryDeferred.delete(entry.id);
            }
          } catch (error) {
            if (!(error instanceof StaleAttemptError)) throw error;
            o.queue.acknowledge(entry.id);
            retryDeferred.delete(entry.id);
          }
        }
        // The main and dev lanes drain concurrently. A hook intended to observe a finished landing must not
        // be consumed by the idle lane before the lane with queued work reaches its handoff.
        if (processedEntry) await o.beforeRelease?.();
      } finally {
        lease.release();
      }

      if (o.codeIsCurrent && !o.codeIsCurrent()) {
        await handOff();
        return;
      }
      // The empty check is outside the lease: enqueueing while we drained can wake no owner, so retry if needed.
      if (o.queue.nextBatch(1, [...deferred], lane).length) continue;
      if (o.queue.nextBatch(1, [], lane).length) {
        if (deferred.size) {
          if (roundHead !== this.integrationHead()) continue;
          return;
        }
        continue;
      }
      await o.promote?.();
      if (o.codeIsCurrent && !o.codeIsCurrent()) {
        await handOff();
        return;
      }
      if (!o.queue.nextBatch(1, [], lane).length) return;
    }
  }

  private integrationHead(): string | undefined {
    const branch = this.options.integrationBranch;
    if (!branch) return undefined;
    try {
      return git(this.options.mainCheckout, 'rev-parse', `refs/heads/${branch}`);
    } catch {
      return undefined;
    }
  }

  private canBatch(entry: LandingEntry): boolean {
    const o = this.options;
    if (entry.request.managerLanding) return false;
    if (!o.integrationBranch || !o.fence.commitBatchMerge) return false;
    if ((entry.request.affectedTests ?? []).some((test) => test.status === 'failed')) return false;
    const recorded = taskIntegrationTarget(o.stateDirectory, entry.request.taskId);
    return !recorded.workspace && recorded.target !== 'stabilize' && !controlPlaneReleaseBrief(recorded);
  }

  private async integrateBatch(entries: readonly LandingEntry[]): Promise<BatchLandingResult> {
    const o = this.options;
    const outcomes = new Map<number, GateOutcome>();
    const deferred = new Set<number>();
    const skipped = new Set<number>();
    let pending = [...entries];
    const mainBranch = o.mainBranch ?? 'main';
    const branch = o.integrationBranch!;
    const targetRef = `refs/heads/${branch}`;
    const target = () => git(o.mainCheckout, 'rev-parse', targetRef);
    const planner = o.fence as AttemptFence & {
      planIntegration?: (ref: AttemptRef, base: string, commit: string, commits: readonly string[]) => void;
    };

    const createResult = (entry: LandingEntry, logPath: string): GateOutcome => ({
      taskId: entry.request.taskId,
      attempt: entry.request.attempt,
      passed: false,
      stage: 'setup',
      logPath,
      hostMs: 0,
      changedFiles: [],
      diffLines: 0,
    });
    const resetTo = (tree: string, commit: string) => {
      try {
        git(tree, 'rebase', '--abort');
      } catch {}
      git(tree, 'reset', '--hard', commit);
      git(tree, 'clean', '-fdx');
    };
    const orderedOutcomes = () =>
      entries.flatMap((entry) => {
        const outcome = outcomes.get(entry.id);
        return outcome ? [{ entry, outcome }] : [];
      });
    const discardIntegratedMembers = (): boolean => {
      const store = o.fence;
      if (!(store instanceof WorkerStore)) return false;
      const integrated = new Set(
        pending
          .filter((entry) => ['integrated', 'merged'].includes(store.task(entry.request.taskId).state))
          .map((entry) => entry.id),
      );
      if (!integrated.size) return false;
      for (const id of integrated) skipped.add(id);
      pending = pending.filter((entry) => !integrated.has(entry.id));
      return true;
    };

    while (pending.length) {
      discardIntegratedMembers();
      if (!pending.length) break;
      const trainTree = resolve(o.worktreeRoot, `train-batch-${randomUUID()}`);
      const logPaths = new Map<number, string>();
      const memberStarted = new Map<number, number>();
      const prepared: PreparedLanding[] = [];
      const localOutcomes = new Map<number, GateOutcome>();
      let base = '';
      let previous = '';
      let added = false;
      let prepareRemoval: (() => void) | undefined;
      let retry = false;
      let committed = false;
      let stale: LandingEntry | undefined;
      try {
        for (const entry of pending) {
          const logPath = join(o.stateDirectory, `landing-${entry.id}.log`);
          logPaths.set(entry.id, logPath);
          memberStarted.set(entry.id, Date.now());
          writeFileSync(logPath, '');
        }
        if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
          throw new Error('The main checkout must already have main checked out');
        base = target();
        previous = base;
        mkdirSync(resolve(o.worktreeRoot), { recursive: true });
        git(o.mainCheckout, 'worktree', 'add', '--detach', trainTree, base);
        added = true;
        prepareRemoval = captureTrainWorktreeRemoval(trainTree);

        for (const entry of pending) {
          const request = entry.request;
          const logPath = logPaths.get(entry.id)!;
          const result = createResult(entry, logPath);
          try {
            o.fence.assertCurrent(request);
          } catch (error) {
            if (!(error instanceof StaleAttemptError)) throw error;
            stale = entry;
            break;
          }
          const tip = git(o.mainCheckout, 'rev-parse', '--verify', `${request.branch}^{commit}`);
          const originalBase = git(o.mainCheckout, 'merge-base', tip, base);
          const derivedFiles = o.derivedFiles ?? defaultDerivedFiles;
          git(trainTree, 'reset', '--hard', tip);
          git(trainTree, 'clean', '-fdx');
          const frozenAtStart = frozenFilesForTask(o.stateDirectory, request.taskId);
          const changedFrozenAtSource = changedFrozenFiles(trainTree, frozenAtStart);
          if (changedFrozenAtSource.length) {
            const changedFrozenOnTarget = new Set(frozenFilesModifiedAtCommit(trainTree, previous, frozenAtStart));
            refuseFrozenAcceptanceChange(result, changedFrozenAtSource, logPath);
            // Keep the historical path diagnostic for a worker-only frozen-file change. If the target also
            // changed that immutable input, the typed refusal is the complete cause and this is not a Git conflict.
            const workerOnlyFrozenChanges = changedFrozenAtSource.filter((path) => !changedFrozenOnTarget.has(path));
            if (workerOnlyFrozenChanges.length)
              result.conflictedFiles = canonicalConflictPaths(workerOnlyFrozenChanges);
            localOutcomes.set(entry.id, result);
            resetTo(trainTree, previous);
            continue;
          }
          const frozenPaths = new Set(frozenAtStart.map((file) => file.path));
          const worked = git(trainTree, 'diff', '--name-only', originalBase, 'HEAD')
            .split('\n')
            .some((path) => path && !frozenPaths.has(path));
          if (!worked) {
            result.stage = 'rebase';
            result.firstFailure = firstFailure(
              'No committed changes beyond the base and the frozen acceptance files: commit the work before finishing',
            );
            appendFileSync(logPath, `${result.firstFailure.assertion}\n`);
            localOutcomes.set(entry.id, result);
            resetTo(trainTree, previous);
            continue;
          }

          try {
            rebaseOnto(trainTree, previous, originalBase, logPath, derivedFiles, request.declaredPaths);
          } catch (error) {
            const conflicts = unmergedFiles(trainTree);
            if (conflicts.length) {
              const context = makeRebaseConflictContext(previous, request.workerCommit ?? tip, conflicts);
              if (context) result.rebaseConflict = context;
            }
            if (error instanceof WorkerConflictError) {
              refuseNoEffect(result, [error.path], logPath, error.detail ? error.message : undefined);
              localOutcomes.set(entry.id, result);
              try {
                git(trainTree, 'rebase', '--abort');
              } catch {}
              resetTo(trainTree, previous);
              continue;
            }
            // Deferral is for a conflict with an earlier member of this batch. First in its batch, the landing
            // conflicts with dev itself and only its worker can resolve that: deferred again every round, a busy
            // queue kept one landing waiting 3 h 41 min with no outcome.
            if (conflicts.length && previous !== base) {
              appendFileSync(
                logPath,
                `Deferred until a later batch round; rebase conflicts: ${conflicts.join(', ')}\n`,
              );
              deferred.add(entry.id);
            } else if (conflicts.length) {
              result.stage = 'rebase';
              result.conflictedFiles = canonicalConflictPaths(conflicts);
              result.firstFailure = firstFailure(String(error));
              appendFileSync(logPath, `Rebase conflicts with dev: ${conflicts.join(', ')}\n`);
              localOutcomes.set(entry.id, result);
            } else {
              result.stage = 'rebase';
              result.firstFailure = firstFailure(String(error));
              appendFileSync(logPath, `${String(error)}\n`);
              localOutcomes.set(entry.id, result);
            }
            resetTo(trainTree, previous);
            continue;
          }

          const frozen = frozenFilesForTask(o.stateDirectory, request.taskId);
          const changedFrozen = changedFrozenFiles(trainTree, frozen);
          if (changedFrozen.length) {
            refuseFrozenAcceptanceChange(result, changedFrozen, logPath);
            localOutcomes.set(entry.id, result);
            resetTo(trainTree, previous);
            continue;
          }

          result.stage = 'scope';
          result.changedFiles = changedFiles(trainTree, previous);
          result.diffLines = diffLineCount(trainTree, previous);
          result.nonGeneratedChangedFiles = nonGeneratedFiles(trainTree, result.changedFiles);
          result.nonGeneratedDiffLines = diffLineCount(trainTree, previous, result.nonGeneratedChangedFiles);
          try {
            this.checkScope(
              result.changedFiles.filter((path) => !derivedForPath(path, derivedFiles).length),
              request,
              logPath,
            );
          } catch (error) {
            result.firstFailure = firstFailure(String(error));
            localOutcomes.set(entry.id, result);
            resetTo(trainTree, previous);
            continue;
          }

          const formatCommand = o.formatCommand ?? [
            resolve(o.mainCheckout, 'node_modules/.bin/oxfmt'),
            ...FORMAT_FLAGS,
          ];
          const formatFiles = result.changedFiles.filter((path) => existsSync(join(trainTree, path)));
          const formatterAvailable =
            !formatCommand[0]!.endsWith('/node_modules/.bin/oxfmt') || existsSync(formatCommand[0]!);
          if (formatFiles.length && formatterAvailable) {
            const formatted = spawnSync(formatCommand[0]!, [...formatCommand.slice(1), ...formatFiles], {
              cwd: trainTree,
              encoding: 'utf8',
            });
            const output = `${formatted.stdout ?? ''}${formatted.stderr ?? ''}`;
            appendFileSync(logPath, `$ ${[...formatCommand, ...formatFiles].join(' ')} (cwd: ${trainTree})\n${output}`);
            if (formatted.status !== 0) {
              result.stage = 'setup';
              result.firstFailure = firstFailure(
                `Formatter failed: ${output || formatted.error?.message || 'command failed'}`,
              );
              localOutcomes.set(entry.id, result);
              resetTo(trainTree, previous);
              continue;
            }
            if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: trainTree }).status !== 0) {
              git(trainTree, 'add', '--', ...formatFiles);
              git(trainTree, 'commit', '-m', `style: format ${request.taskId}`);
            }
            result.changedFiles = changedFiles(trainTree, previous);
            result.diffLines = diffLineCount(trainTree, previous);
            result.nonGeneratedChangedFiles = nonGeneratedFiles(trainTree, result.changedFiles);
            result.nonGeneratedDiffLines = diffLineCount(trainTree, previous, result.nonGeneratedChangedFiles);
            try {
              this.checkScope(
                result.changedFiles.filter((path) => !derivedForPath(path, derivedFiles).length),
                request,
                logPath,
              );
            } catch (error) {
              result.stage = 'scope';
              result.firstFailure = firstFailure(String(error));
              localOutcomes.set(entry.id, result);
              resetTo(trainTree, previous);
              continue;
            }
          }

          const candidate = git(trainTree, 'rev-parse', 'HEAD');
          const taskPaths = changedPathsBetween(o.mainCheckout, originalBase, tip);
          if (treeDiffIsEmpty(trainTree, previous, candidate)) {
            refuseNoEffect(result, taskPaths, logPath);
            localOutcomes.set(entry.id, result);
            resetTo(trainTree, previous);
            continue;
          }
          const noEffect = pathsChangedByTaskButUnchangedOnDev(trainTree, previous, candidate, tip, taskPaths);
          if (noEffect.length) {
            refuseNoEffect(result, noEffect, logPath);
            localOutcomes.set(entry.id, result);
            resetTo(trainTree, previous);
            continue;
          }
          const commits = git(trainTree, 'rev-list', '--reverse', `${previous}..${candidate}`)
            .split('\n')
            .filter(Boolean);
          prepared.push({ entry, result, base: previous, candidate, commits, started: memberStarted.get(entry.id)! });
          previous = candidate;
        }

        if (stale) {
          skipped.add(stale.id);
          pending = pending.filter((entry) => entry.id !== stale!.id);
          retry = true;
          continue;
        }
        if (target() !== base) {
          retry = true;
          continue;
        }
        if (!prepared.length) {
          if (target() !== base) {
            retry = true;
            continue;
          }
          for (const outcome of localOutcomes.values()) {
            try {
              o.fence.assertCurrent(outcome);
            } catch (error) {
              if (!(error instanceof StaleAttemptError)) throw error;
              const staleEntry = pending.find((entry) => entry.request.taskId === error.ref.taskId);
              if (staleEntry) {
                skipped.add(staleEntry.id);
                pending = pending.filter((entry) => entry.id !== staleEntry.id);
                retry = true;
                break;
              }
              throw error;
            }
          }
          if (retry) continue;
          for (const [id, outcome] of localOutcomes) {
            outcome.hostMs = Date.now() - memberStarted.get(id)!;
            outcomes.set(id, outcome);
          }
          for (const id of deferred) outcomes.delete(id);
          return {
            outcomes: orderedOutcomes(),
            deferredIds: [...deferred],
            skippedIds: [...skipped],
          };
        }

        // The final rebased tree includes conflict resolution and formatting. It receives the one mandatory
        // prelanding typecheck; other verification runs after integration in the independent verifier.
        const finalCandidate = prepared[prepared.length - 1]!.candidate;
        git(trainTree, 'reset', '--hard', prepared[prepared.length - 1]!.candidate);
        if (
          !existsSync(join(trainTree, 'node_modules')) &&
          existsSync(join(trainTree, 'bun.lock')) &&
          existsSync(join(trainTree, 'package.json'))
        )
          installShared(trainTree);
        const batchLog = logPaths.get(prepared[0]!.entry.id)!;
        const { command, result: checked } = await this.checkDevCandidate(trainTree, base, finalCandidate, batchLog);
        for (const member of prepared)
          appendFileSync(
            member.result.logPath,
            `Root typecheck ${checked.passed ? 'passed' : 'failed'}${checked.timedOut ? ' (timed out)' : ''}\n${checked.output}`,
          );
        let staleAfterGate: LandingEntry | undefined;
        for (const member of pending) {
          try {
            o.fence.assertCurrent(member.request);
          } catch (error) {
            if (!(error instanceof StaleAttemptError)) throw error;
            staleAfterGate = member;
            break;
          }
        }
        if (staleAfterGate) {
          skipped.add(staleAfterGate.id);
          pending = pending.filter((entry) => entry.id !== staleAfterGate!.id);
          retry = true;
          continue;
        }
        if (target() !== base) {
          retry = true;
          continue;
        }
        if (!checked.passed) {
          const output = checked.output || 'Root typecheck failed without compiler output';
          const namedOwners = prepared.filter((member) =>
            member.result.changedFiles.some((path) => compilerOutputMatchesPath(output, trainTree, path)),
          );
          const workspaceOwners = prepared.filter((member) =>
            member.result.changedFiles.some((file) => {
              let directory = join(trainTree, file);
              while (directory.startsWith(`${trainTree}/`) && directory !== trainTree) {
                directory = dirname(directory);
                const manifest = join(directory, 'package.json');
                if (!existsSync(manifest)) continue;
                try {
                  const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
                  if (typeof name === 'string' && output.includes(`Workspace ${name} finished`)) return true;
                } catch {
                  return false;
                }
              }
              return false;
            }),
          );
          const owners = namedOwners.length ? namedOwners : workspaceOwners.length ? workspaceOwners : prepared;
          const ownerIds = new Set(owners.map((member) => member.entry.id));
          for (const member of prepared) {
            if (!ownerIds.has(member.entry.id)) {
              deferred.add(member.entry.id);
              continue;
            }
            member.result.stage = 'gate';
            member.result.firstFailure = firstFailure(output);
            member.result.failedCommand = [...command];
            member.result.timedOut = checked.timedOut;
            appendFileSync(member.result.logPath, `\nRequired root typecheck failed:\n${output}\n`);
            outcomes.set(member.entry.id, member.result);
          }
          for (const [id, outcome] of localOutcomes) outcomes.set(id, outcome);
          return {
            outcomes: orderedOutcomes(),
            deferredIds: [...deferred],
            skippedIds: [...skipped],
          };
        }
        for (const member of prepared) {
          planner.planIntegration?.(member.entry.request, member.base, member.candidate, member.commits);
          o.queue.candidate(member.entry.id, member.candidate);
        }
        if (target() !== base) {
          retry = true;
          continue;
        }
        if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
          throw new Error('Main checkout HEAD changed while integrating');
        const commitBatchMerge = o.fence.commitBatchMerge;
        if (!commitBatchMerge) throw new Error('Attempt fence does not support atomic batch landing');
        const head = prepared[prepared.length - 1]!.candidate;
        const advanced = commitBatchMerge.call(
          o.fence,
          prepared.map((member) => ({ ...member.entry.request, commit: member.candidate })),
          () => {
            if (target() !== base) return '';
            if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
              throw new Error('Main checkout HEAD changed');
            o.beforeIntegrationAdvance?.();
            assertCandidateIntegrity(
              trainTree,
              head,
              'dev root typecheck before batch ref advance',
              logPaths.get(prepared[0]!.entry.id)!,
              o.runCandidateGit,
            );
            try {
              git(o.mainCheckout, 'update-ref', targetRef, head, base);
            } catch (error) {
              if (target() !== base) return '';
              throw error;
            }
            return head;
          },
        );
        if (!advanced) {
          retry = true;
          continue;
        }
        committed = true;
        for (const [id, outcome] of localOutcomes) {
          outcome.hostMs = Date.now() - memberStarted.get(id)!;
          outcomes.set(id, outcome);
        }
        for (const member of prepared) {
          member.result.passed = true;
          member.result.stage = 'merge';
          member.result.mergedCommit = member.candidate;
          member.result.hostMs = Date.now() - member.started;
          this.notifyOwnersOfOutsideChanges(
            member.entry.request,
            outsideScope(
              (member.result.changedFiles ?? []).filter(
                (path) => !derivedForPath(path, o.derivedFiles ?? defaultDerivedFiles).length,
              ),
              member.entry.request.declaredPaths,
            ),
            member.candidate,
            branch,
            member.result.logPath,
          );
          outcomes.set(member.entry.id, member.result);
        }
        for (const id of deferred) outcomes.delete(id);
        return {
          outcomes: orderedOutcomes(),
          deferredIds: [...deferred],
          skippedIds: [...skipped],
        };
      } catch (error) {
        if (committed) throw error;
        if (error instanceof StaleAttemptError) {
          const staleEntry = pending.find(
            (entry) => entry.request.taskId === error.ref.taskId && entry.request.attempt === error.ref.attempt,
          );
          if (!staleEntry) throw error;
          skipped.add(staleEntry.id);
          pending = pending.filter((entry) => entry.id !== staleEntry.id);
          retry = true;
        } else if (String(error).includes('attempt already integrated') && discardIntegratedMembers()) {
          retry = true;
        } else {
          const message = String(error);
          for (const entry of pending) {
            const logPath = logPaths.get(entry.id)!;
            appendFileSync(logPath, `${message}\n`);
            const result = createResult(entry, logPath);
            result.stage = 'setup';
            result.firstFailure = firstFailure(message);
            result.hostMs = Date.now() - memberStarted.get(entry.id)!;
            outcomes.set(entry.id, result);
          }
          for (const [id, outcome] of localOutcomes) outcomes.set(id, outcome);
          return { outcomes: orderedOutcomes(), deferredIds: [...deferred], skippedIds: [...skipped] };
        }
      } finally {
        if (added) {
          try {
            git(trainTree, 'rebase', '--abort');
          } catch {}
          try {
            git(trainTree, 'merge', '--abort');
          } catch {}
          try {
            prepareRemoval?.();
            git(o.mainCheckout, 'worktree', 'remove', '--force', trainTree);
          } catch (error) {
            for (const logPath of logPaths.values())
              appendFileSync(logPath, `Train tree cleanup deferred: ${trainTree}: ${error}\n`);
          }
        }
      }
      if (retry) continue;
    }
    return { outcomes: orderedOutcomes(), deferredIds: [...deferred], skippedIds: [...skipped] };
  }

  /** Main may borrow idle dev custody, but product work always gets the next turn. */
  private async integrateOrdinary(
    entry: LandingEntry,
    lane: 'main' | 'dev',
    handOff: () => Promise<void>,
  ): Promise<GateOutcome | undefined> {
    const o = this.options;
    if (
      lane !== 'main' ||
      o.integrationBranch === undefined ||
      !controlPlaneReleaseBrief(taskIntegrationTarget(o.stateDirectory, entry.request.taskId))
    )
      return this.integrate(entry);

    const drainDev = () => this.drain('dev', false, handOff);
    const devPending = () => o.queue.nextBatch(1, [], 'dev').length > 0;
    const timeoutMs = o.controlPlaneDevLeaseTimeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
      throw new Error('Control-plane dev lease wait must be within 30 seconds');
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      o.fence.assertCurrent(entry.request);
      if (o.codeIsCurrent && !o.codeIsCurrent()) return;
      if (devPending()) {
        // The initial dev drain may have found another owner. Use the same native lane again, never take its lease
        // ahead of its backlog. A live owner remains responsible for its own shutdown queue recheck.
        await drainDev();
        if (devPending()) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) return;
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
          continue;
        }
      }
      let lease: ReturnType<typeof acquireDirectoryLease>;
      try {
        lease = acquireDirectoryLease(join(o.stateDirectory, 'train.lease'));
      } catch (error) {
        if (!(error instanceof LeaseHeldError)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          appendFileSync(
            join(o.stateDirectory, `landing-${entry.id}.log`),
            `Control-plane release deferred: dev train lease held after waiting ${timeoutMs}ms; request remains pending\n`,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
        continue;
      }
      let yielded = false;
      try {
        o.fence.assertCurrent(entry.request);
        if (o.codeIsCurrent && !o.codeIsCurrent()) return;
        return await this.runOrdinaryProof(entry, devPending, () => {
          yielded = true;
        });
      } finally {
        lease.release();
        // Cancellation has settled every owned command before this point. Drain actual product requests even when
        // the original idle dev drain has already returned, and even if no other controller was spawned on enqueue.
        if (yielded) await drainDev();
      }
    }
  }

  private async runOrdinaryProof(
    entry: LandingEntry,
    devPending: () => boolean,
    onYield: () => void,
  ): Promise<GateOutcome | undefined> {
    const o = this.options;
    const path = join(o.stateDirectory, `control-plane-proof-${entry.id}.json`);
    const history = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as { version: number; attempts: OrdinaryProofAttempt[] })
      : { version: 1, attempts: [] as OrdinaryProofAttempt[] };
    if (history.version !== 1 || !Array.isArray(history.attempts))
      throw new Error('Invalid ordinary control-plane proof journal');
    const save = () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    };
    const source = git(o.mainCheckout, 'rev-parse', `refs/heads/${entry.request.branch}`);
    const snapshot = this.controlPlaneSnapshot(o.mainBranch ?? 'main');
    const previous = history.attempts.at(-1);
    if (previous?.status === 'running') {
      // A new lease owner cannot inherit a partially run proof from a crashed controller.
      previous.status = 'interrupted';
      previous.reason = 'Previous controller exited before proof completion';
      appendFileSync(previous.logPath, `${previous.reason}; proof remains non-green\n`);
      save();
    }
    if (previous?.source === source) {
      // A real assertion failure belongs to its source owner, regardless of unrelated dev progress.
      if (previous.status === 'finished' && previous.outcome && !previous.outcome.passed) return previous.outcome;
      if (previous.status === 'interrupted' && JSON.stringify(previous.snapshot) === JSON.stringify(snapshot)) return;
    }
    const attempts = history.attempts.filter((attempt) => attempt.source === source);
    const logPath = join(o.stateDirectory, `landing-${entry.id}-proof-${history.attempts.length + 1}.log`);
    if (attempts.length >= 3) {
      const output = 'Control-plane proof interrupted three times for this source; owning source decision required';
      appendFileSync(previous!.logPath, `${output}\n`);
      return {
        ...entry.request,
        passed: false,
        stage: 'gate',
        firstFailure: firstFailure(output),
        logPath: previous!.logPath,
        hostMs: 0,
        changedFiles: [],
        diffLines: 0,
      };
    }
    const attempt: OrdinaryProofAttempt = { source, snapshot, logPath, status: 'running' };
    history.attempts.push(attempt);
    save();
    const controller = new AbortController();
    let failure: (GateResult & { failedCommand: readonly string[] }) | undefined;
    const observe = () => {
      if (controller.signal.aborted) return;
      if (devPending()) controller.abort(new ControlPlaneProofInterrupted('Product dev request needs the dev lane'));
      else if (o.codeIsCurrent && !o.codeIsCurrent())
        controller.abort(
          new ControlPlaneProofInterrupted('Control-plane code changed; current controller must hand off'),
        );
      else {
        try {
          o.fence.assertCurrent(entry.request);
        } catch (error) {
          controller.abort(error);
        }
      }
    };
    const checkpoint = () => {
      observe();
      controller.signal.throwIfAborted();
      if (git(o.mainCheckout, 'rev-parse', `refs/heads/${entry.request.branch}`) !== source) {
        const error = new Error(
          'Accepted control-plane source ref changed during proof; owning source decision required',
        );
        controller.abort(error);
        throw error;
      }
    };
    const custody: OrdinaryProofCustody = {
      signal: controller.signal,
      logPath,
      checkpoint,
      capture(candidate, snapshot) {
        const spent = attempts.reduce((total, prior) => total + Math.max(1, prior.validations ?? 0), 0);
        if (spent + (attempt.validations ?? 0) >= 5)
          throw new Error('Control-plane source exhausted five candidate validations; owning source decision required');
        attempt.validations = (attempt.validations ?? 0) + 1;
        attempt.candidate = candidate;
        attempt.snapshot = snapshot;
        save();
      },
      run: (runner) => async (argv, cwd, log) => {
        checkpoint();
        const result = await runner(argv, cwd, log, { signal: controller.signal });
        if (!result.passed) failure ??= { ...result, failedCommand: [...argv] };
        checkpoint();
        return result;
      },
    };
    const timer = setInterval(() => {
      try {
        observe();
      } catch (error) {
        controller.abort(error);
      }
    }, 50);
    try {
      const outcome = await this.integrate(entry, custody);
      attempt.status = 'finished';
      attempt.outcome = outcome;
      save();
      return outcome;
    } catch (error) {
      attempt.status = 'interrupted';
      attempt.reason = String(error);
      appendFileSync(logPath, `${error}; proof remains non-green, no publication or reusable proof\n`);
      if (failure) {
        // Do not turn an observed assertion failure into a new proof admission merely because dev also arrived.
        const outcome: GateOutcome = {
          taskId: entry.request.taskId,
          attempt: entry.request.attempt,
          passed: false,
          stage: 'gate',
          logPath,
          hostMs: 0,
          changedFiles: [],
          diffLines: 0,
          firstFailure: firstFailure(failure.output),
          failedCommand: failure.failedCommand,
          timedOut: failure.timedOut,
        };
        attempt.status = 'finished';
        attempt.outcome = outcome;
        save();
        if (error instanceof ControlPlaneProofInterrupted) onYield();
        else if (error instanceof StaleAttemptError) throw error;
        return outcome;
      }
      save();
      if (!(error instanceof ControlPlaneProofInterrupted)) {
        if (error instanceof StaleAttemptError) throw error;
        const outcome: GateOutcome = {
          taskId: entry.request.taskId,
          attempt: entry.request.attempt,
          passed: false,
          stage: 'gate',
          logPath,
          hostMs: 0,
          changedFiles: [],
          diffLines: 0,
          firstFailure: firstFailure(String(error)),
        };
        attempt.status = 'finished';
        attempt.outcome = outcome;
        save();
        return outcome;
      }
      onYield();
      return;
    } finally {
      clearInterval(timer);
    }
  }

  private async integrate(entry: LandingEntry, custody?: OrdinaryProofCustody): Promise<GateOutcome> {
    const o = this.options;
    const assertCandidate = (cwd: string, expected: string, phase: string, logPath: string) =>
      assertCandidateIntegrity(cwd, expected, phase, logPath, o.runCandidateGit);
    const request = entry.request;
    const mainBranch = o.mainBranch ?? 'main';
    const recorded = taskIntegrationTarget(o.stateDirectory, request.taskId);
    const sharedStore = recorded.workspace && o.fence instanceof WorkerStore ? o.fence : undefined;
    const workspace = sharedStore
      ? new WorkspaceController(
          {
            mainCheckout: o.mainCheckout,
            stateDirectory: o.stateDirectory,
            worktreeRoot: o.worktreeRoot,
            integrationBranch: o.integrationBranch ?? 'dev',
          },
          sharedStore,
        )
      : undefined;
    let sharedTasks: Task[] = [];
    let sharedSource = '';

    let integrationTarget: IntegrationTarget =
      recorded.target === 'stabilize' && recorded.goal !== 'control-plane'
        ? 'stabilize'
        : (recorded.target === 'main' && recorded.goal !== 'control-plane') || o.integrationBranch === undefined
          ? 'main'
          : 'integration';
    let targetBranch =
      integrationTarget === 'stabilize'
        ? (o.stabilizeBranch ?? localBranchSettings(o.mainCheckout).stabilizeBranch ?? 'stabilize')
        : integrationTarget === 'integration'
          ? o.integrationBranch!
          : mainBranch;
    let targetRef = `refs/heads/${targetBranch}`;
    let controlPlane = false;
    let stabilize = integrationTarget === 'stabilize';
    // A stabilize task uses the same rebase, check and compare-and-swap path, aimed at the stabilize branch.
    let integratesIntoDev = integrationTarget !== 'main';
    const started = Date.now();
    const logPath = custody?.logPath ?? join(o.stateDirectory, `landing-${entry.id}.log`);
    writeFileSync(logPath, '');
    const result: GateOutcome = {
      taskId: request.taskId,
      attempt: request.attempt,
      passed: false,
      stage: 'setup',
      logPath,
      hostMs: 0,
      changedFiles: [],
      diffLines: 0,
    };
    const attributeFailure = (failed: GateOutcome, owners?: Task[]) => {
      if (!workspace || !sharedStore || !sharedTasks.length) return;
      const named = failingTestFiles(failed.firstFailure?.excerpt ?? '');
      const matched = named.length
        ? sharedTasks.filter((task) => taskChangedPaths(task, sharedSource).some((path) => named.includes(path)))
        : [];
      const responsible = owners ?? (matched.length ? matched : sharedTasks);
      this.workspaceFailures.set(
        entry.id,
        responsible.map((task) => ({ ...failed, taskId: task.id, attempt: task.currentAttempt })),
      );
    };
    const finish = () => {
      if (!result.passed && !this.workspaceFailures.has(entry.id)) attributeFailure(result);
      return result;
    };
    let stage: GateStage = 'setup';
    const trainTree = resolve(o.worktreeRoot, `train-${randomUUID()}`);
    let added = false;
    let prepareRemoval: (() => void) | undefined;
    let workerCommit: string | undefined;
    let activeTargetHead: string | undefined;
    const runOwnedAffected = (command: readonly string[], cwd: string, log: string, env: NodeJS.ProcessEnv) =>
      runAffectedTest(command, cwd, log, env, custody ? { signal: custody.signal } : undefined);
    const runGate = custody ? custody.run(o.runGate ?? gateRunner()) : (o.runGate ?? gateRunner());
    const target = () => git(o.mainCheckout, 'rev-parse', targetRef);
    const refreshManagerLanding = () => {
      if (request.managerLanding) return;
      const row = o.queue.db.query('SELECT request FROM landing_queue WHERE id=?').get(entry.id) as {
        request: string;
      } | null;
      if (!row) return;
      const latest = JSON.parse(row.request) as LandingRequest;
      if (!latest.managerLanding) return;
      if (!(o.fence instanceof WorkerStore)) throw new Error('Manager landing requires the worker outcome store');
      Object.assign(request, latest);
      assertManagerLandingEvidence(request, o.fence);
    };
    let controlPlaneRefChanges = 0;
    const retryMovedControlPlaneRefs = (): void => {
      controlPlaneRefChanges++;
      appendFileSync(
        logPath,
        `Control-plane release refs moved during validation (${controlPlaneRefChanges}/5); rebuilding the candidate checks\n`,
      );
      if (controlPlaneRefChanges >= 5)
        throw new Error('Control-plane release refs kept moving during five validation attempts');
    };
    const recoverAlreadyIntegrated = async (): Promise<boolean> => {
      if (!entry.candidate) return false;
      try {
        git(o.mainCheckout, 'merge-base', '--is-ancestor', entry.candidate, targetBranch);
      } catch {
        return false;
      }
      if (controlPlane) {
        const release = this.readControlPlaneRecord(request);
        if (!release || release.mainCommit !== entry.candidate || !this.controlPlaneRecordPublished(release)) {
          result.stage = 'merge';
          result.firstFailure = firstFailure(
            `Control-plane candidate ${entry.candidate} is on ${mainBranch} without complete verified propagation; refusing to report the landing complete`,
          );
          appendFileSync(logPath, `${result.firstFailure.assertion}\n`);
          return true;
        }
        this.syncMainCheckout(mainBranch, [release.mainExpected, release.mainCommit]);
        appendFileSync(
          logPath,
          `Recovered complete control-plane release candidate=${release.mainCommit} dev-script-tree=${release.devScriptTree} dev=${release.devCommit}` +
            `${release.stabilizeCommit ? ` stabilize=${release.stabilizeCommit}` : ''}\n`,
        );
        result.passed = true;
        result.stage = 'merge';
        result.mergedCommit = entry.candidate;
        return true;
      }
      result.passed = true;
      result.stage = 'merge';
      result.mergedCommit = entry.candidate;
      if (workspace) workspace.integrated(recorded.workspace!.module, target());
      if (controlPlane)
        await this.propagateControlPlaneCommit(entry.candidate, request.taskId, recorded.manager, logPath);
      else if (stabilize) {
        mkdirSync(resolve(o.worktreeRoot), { recursive: true });
        git(o.mainCheckout, 'worktree', 'add', '--detach', trainTree, entry.candidate);
        added = true;
        prepareRemoval = captureTrainWorktreeRemoval(trainTree);
        await this.mergeStabilizedCommitIntoDev(entry.candidate, trainTree, request.taskId, recorded.manager, logPath);
      }
      return true;
    };
    try {
      o.fence.assertCurrent(request);
      if (request.managerLanding) {
        if (!(o.fence instanceof WorkerStore)) throw new Error('Manager landing requires the worker outcome store');
        assertManagerLandingEvidence(request, o.fence, { allowIntegrated: true });
      }
      if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
        throw new Error('The main checkout must already have main checked out');
      const tip = git(o.mainCheckout, 'rev-parse', '--verify', `${request.branch}^{commit}`);
      workerCommit = request.workerCommit ?? tip;
      if (workspace && sharedStore) {
        sharedSource = tip;
        const task = sharedStore.task(request.taskId);
        const own = taskCommits(task, tip);
        if (!own.length)
          throw new Error('No Goal-Task trailer commits for this task: commit your own work before finishing');
        if (own.every((commit) => workspaceAncestor(o.mainCheckout, commit, target()))) {
          workspace.integrated(recorded.workspace!.module, target());
          result.passed = true;
          result.stage = 'merge';
          result.mergedCommit = target();
          await workspace.withLaunch(recorded.workspace!.module, () => workspace.syncIdle(recorded.workspace!.module));
          return finish();
        }
        const attribution = workspaceCommits(task.worktree, workspace.workspace(recorded.workspace!.module).base, tip);
        sharedTasks = sharedStore
          .tasks()
          .filter(
            (candidate) =>
              candidate.workspace?.module === recorded.workspace!.module &&
              !['cancelled', 'merged'].includes(candidate.state) &&
              attribution.has(candidate.id) &&
              attribution.get(candidate.id)!.some((commit) => !workspaceAncestor(o.mainCheckout, commit, target())),
          );
      }

      // Control-plane branches start on main, so measure their work from their fork from main. The recorded base can
      // lag after retries, and measuring against dev would include unrelated dev-only commits in the control-plane
      // diff. Only the commits after the main fork are considered for the main landing.
      let controlPlaneFork: string | undefined;
      if (!workspace && controlPlaneReleaseBrief(recorded) && o.integrationBranch !== undefined) {
        const fork = git(o.mainCheckout, 'merge-base', tip, `refs/heads/${mainBranch}`);
        const taskChanges = changedPathsBetween(o.mainCheckout, fork, tip);
        controlPlane = taskChanges.length > 0 && taskChanges.every((path) => path.startsWith(CONTROL_PLANE_PATH));
        if (controlPlane) controlPlaneFork = fork;
      }
      if (controlPlane) {
        integrationTarget = 'main';
        targetBranch = mainBranch;
        targetRef = `refs/heads/${targetBranch}`;
        stabilize = false;
        integratesIntoDev = false;
      }
      // Recover an advance that committed before its outcome was saved.
      if (await recoverAlreadyIntegrated()) return finish();
      const originalBase = controlPlaneFork ?? git(o.mainCheckout, 'merge-base', tip, target());
      mkdirSync(resolve(o.worktreeRoot), { recursive: true });
      git(o.mainCheckout, 'worktree', 'add', '--detach', trainTree, tip);
      added = true;
      prepareRemoval = captureTrainWorktreeRemoval(trainTree);
      for (;;) {
        o.fence.assertCurrent(request);
        delete result.firstFailure;
        delete result.failsOnMain;
        delete result.timedOut;
        delete result.failedCommand;
        const base = target();
        activeTargetHead = base;
        const releaseSnapshot = controlPlane ? this.controlPlaneSnapshot(mainBranch) : undefined;
        let lifecycleEvidence: string | undefined;
        let compatibilityCommand: string[] | undefined;
        if (releaseSnapshot && releaseSnapshot.mainHead !== base) {
          retryMovedControlPlaneRefs();
          continue;
        }
        stage = 'rebase';
        git(trainTree, 'reset', '--hard', tip);
        git(trainTree, 'clean', '-fdx');
        const derivedFiles = o.derivedFiles ?? defaultDerivedFiles;
        // A worker that left its work uncommitted would otherwise integrate nothing and release its dependents. The
        // controller commits the frozen acceptance files itself, so they are not the worker's work.
        const frozenAtStart =
          workspace && sharedStore
            ? sharedStore
                .tasks()
                .filter((task) => task.workspace?.module === recorded.workspace!.module)
                .flatMap((task) => frozenFilesForTask(o.stateDirectory, task.id))
            : frozenFilesForTask(o.stateDirectory, request.taskId);
        const changedFrozenAtSource = changedFrozenFiles(trainTree, frozenAtStart);
        if (changedFrozenAtSource.length) {
          const changedFrozenOnTarget = new Set(frozenFilesModifiedAtCommit(trainTree, base, frozenAtStart));
          refuseFrozenAcceptanceChange(result, changedFrozenAtSource, logPath);
          // Keep the historical path diagnostic for a worker-only frozen-file change. If the target also
          // changed that immutable input, the typed refusal is the complete cause and this is not a Git conflict.
          const workerOnlyFrozenChanges = changedFrozenAtSource.filter((path) => !changedFrozenOnTarget.has(path));
          if (workerOnlyFrozenChanges.length) result.conflictedFiles = canonicalConflictPaths(workerOnlyFrozenChanges);
          if (workspace) {
            const owners = sharedTasks.filter((task) =>
              taskChangedPaths(task, tip).some((path) => changedFrozenAtSource.includes(path)),
            );
            attributeFailure(result, owners.length ? owners : undefined);
          }
          return finish();
        }
        const frozenPaths = new Set(frozenAtStart.map((file) => file.path));
        const worked = git(trainTree, 'diff', '--name-only', originalBase, 'HEAD')
          .split('\n')
          .some((path) => path && !frozenPaths.has(path));
        if (!worked)
          throw new Error(
            'No committed changes beyond the base and the frozen acceptance files: commit the work before finishing',
          );
        if (workspace) {
          git(trainTree, 'reset', '--hard', base);
          git(trainTree, 'merge', '--no-ff', '--no-edit', tip);
        } else {
          try {
            rebaseOnto(trainTree, base, originalBase, logPath, derivedFiles, request.declaredPaths);
          } catch (error) {
            if (!(error instanceof WorkerConflictError)) throw error;
            refuseNoEffect(result, [error.path], logPath, error.detail ? error.message : undefined);
            return finish();
          }
        }
        if (!stabilize && integratesIntoDev) regenerateLandingDerivedFiles(trainTree, base, derivedFiles, logPath);
        const frozen = workspace
          ? sharedStore!
              .tasks()
              .filter((task) => task.workspace?.module === recorded.workspace!.module)
              .flatMap((task) => frozenFilesForTask(o.stateDirectory, task.id))
          : frozenFilesForTask(o.stateDirectory, request.taskId);
        const changedFrozen = changedFrozenFiles(trainTree, frozen);
        if (changedFrozen.length) {
          stage = 'rebase';
          refuseFrozenAcceptanceChange(result, changedFrozen, logPath);
          if (workspace) {
            const owners = sharedTasks.filter((task) =>
              taskChangedPaths(task, tip).some((path) => changedFrozen.includes(path)),
            );
            attributeFailure(result, owners.length ? owners : undefined);
          }
          return finish();
        }
        stage = 'scope';
        result.changedFiles = changedFiles(trainTree, base);
        result.diffLines = diffLineCount(trainTree, base);
        result.nonGeneratedChangedFiles = nonGeneratedFiles(trainTree, result.changedFiles);
        result.nonGeneratedDiffLines = diffLineCount(trainTree, base, result.nonGeneratedChangedFiles);
        const scopeCheckedFiles = result.changedFiles.filter((path) => !derivedForPath(path, derivedFiles).length);
        if (workspace) {
          const ownership = readRiskOwnership(o.riskAreasFile ?? join(import.meta.dir, '../risk-areas.json'));
          for (const task of sharedTasks) {
            const protectedPaths = Object.entries(ownership.areas)
              .filter(([area]) => !task.brief.riskAreas.includes(area))
              .flatMap(([, paths]) => paths);
            try {
              this.checkScope(
                taskChangedPaths(task, tip).filter((path) => !derivedForPath(path, derivedFiles).length),
                {
                  ...request,
                  declaredPaths: task.brief.paths,
                  protectedPaths,
                },
                logPath,
              );
            } catch (error) {
              result.stage = 'scope';
              result.firstFailure = firstFailure(String(error));
              attributeFailure(result, [task]);
              return finish();
            }
          }
        } else this.checkScope(scopeCheckedFiles, request, logPath);
        if (integratesIntoDev || controlPlane) {
          const formatCommand = o.formatCommand ?? [
            resolve(o.mainCheckout, 'node_modules/.bin/oxfmt'),
            ...FORMAT_FLAGS,
          ];
          const formatFiles = result.changedFiles.filter((path) => existsSync(join(trainTree, path)));
          // Small isolated Git fixtures do not carry the repository's installed formatter.
          const formatterAvailable =
            !formatCommand[0]!.endsWith('/node_modules/.bin/oxfmt') || existsSync(formatCommand[0]!);
          if (formatFiles.length && formatterAvailable) {
            stage = 'setup';
            const argv = [...formatCommand, ...formatFiles];
            if (custody) {
              const formatted = await custody.run(processGroupRunner(undefined, o.stateDirectory))(
                argv,
                trainTree,
                logPath,
              );
              appendFileSync(logPath, `$ ${argv.join(' ')} (cwd: ${trainTree})\n`);
              if (!formatted.passed) throw new Error(`Formatter failed: ${formatted.output || 'command failed'}`);
            } else {
              const formatted = spawnSync(argv[0]!, argv.slice(1), { cwd: trainTree, encoding: 'utf8' });
              const output = `${formatted.stdout ?? ''}${formatted.stderr ?? ''}`;
              appendFileSync(logPath, `$ ${argv.join(' ')} (cwd: ${trainTree})\n${output}`);
              if (formatted.status !== 0)
                throw new Error(`Formatter failed: ${output || formatted.error?.message || 'command failed'}`);
            }
            if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: trainTree }).status !== 0) {
              git(trainTree, 'add', '--', ...formatFiles);
              git(trainTree, 'commit', '-m', `style: format ${request.taskId}`);
            }
            stage = 'scope';
            result.changedFiles = changedFiles(trainTree, base);
            result.diffLines = diffLineCount(trainTree, base);
            result.nonGeneratedChangedFiles = nonGeneratedFiles(trainTree, result.changedFiles);
            result.nonGeneratedDiffLines = diffLineCount(trainTree, base, result.nonGeneratedChangedFiles);
            const formattedScopeCheckedFiles = result.changedFiles.filter(
              (path) => !derivedForPath(path, derivedFiles).length,
            );
            if (!workspace) this.checkScope(formattedScopeCheckedFiles, request, logPath);
          }
        }
        const candidate = git(trainTree, 'rev-parse', 'HEAD');
        const taskPaths = workspace
          ? taskChangedPaths(sharedStore!.task(request.taskId), tip)
          : changedPathsBetween(o.mainCheckout, originalBase, tip);
        if (treeDiffIsEmpty(trainTree, base, candidate)) {
          refuseNoEffect(result, taskPaths, logPath);
          return finish();
        }
        const noEffect = pathsChangedByTaskButUnchangedOnDev(trainTree, base, candidate, tip, taskPaths);
        if (noEffect.length) {
          refuseNoEffect(result, noEffect, logPath);
          return finish();
        }
        const testDefaults = process.env.REZICS_GOAL_TEST_ENVIRONMENT === '1';
        const directDevLanding = integratesIntoDev && !stabilize;
        // The root compiler guard is mandatory even when the optional landing-check setting is disabled.
        const skipDevChecks = directDevLanding;
        if (directDevLanding) {
          stage = 'gate';
          if (
            !existsSync(join(trainTree, 'node_modules')) &&
            existsSync(join(trainTree, 'bun.lock')) &&
            existsSync(join(trainTree, 'package.json'))
          )
            installShared(trainTree);
          const { command, result: checked } = await this.checkDevCandidate(trainTree, base, candidate, logPath);
          o.fence.assertCurrent(request);
          if (target() !== base) continue;
          if (!checked.passed) {
            const output = checked.output || 'Root typecheck failed without compiler output';
            result.stage = 'gate';
            result.timedOut = checked.timedOut;
            result.firstFailure = firstFailure(output);
            result.failedCommand = command;
            appendFileSync(logPath, `\nRequired root typecheck failed:\n${output}\n`);
            if (workspace) {
              const owners = sharedTasks.filter((task) =>
                taskChangedPaths(task, tip).some((path) => compilerOutputMatchesPath(output, trainTree, path)),
              );
              attributeFailure(result, owners.length ? owners : undefined);
            }
            return finish();
          }
        }
        const configuredIntegrationChecks =
          typeof o.integrationChecks === 'function' ? o.integrationChecks() : (o.integrationChecks ?? []);
        const matchingIntegrationChecks = integrationChecksForFiles(result.changedFiles, configuredIntegrationChecks);
        // `clean -fdx` above removed node_modules; remote checks resolve the pinned Bun from it, so every stabilize
        // landing's first check failed before running (2026-10-29). Control-plane landings install their own.
        if (
          !skipDevChecks &&
          !controlPlane &&
          !existsSync(join(trainTree, 'node_modules')) &&
          existsSync(join(trainTree, 'bun.lock')) &&
          existsSync(join(trainTree, 'package.json'))
        )
          installShared(trainTree);
        const affectedFailures: string[] = [];
        let baseTreeFiles: Set<string> | undefined;
        const affectedChecks = skipDevChecks
          ? []
          : landingAffectedChecks(result.changedFiles, Boolean(workspace), o.affectedTests);
        const siblings = siblingTestCommand(
          siblingTestFiles(result.changedFiles, trainTree),
          testDefaults ? undefined : defaults.siblingTests.command,
        );
        if (siblings && !skipDevChecks) affectedChecks.push({ paths: [], command: siblings });
        const landingAffectedResults: AffectedTestResult[] = [];
        if (
          affectedChecks.length &&
          !matchingIntegrationChecks.some((check) => check.command[0] === 'bun' && check.command[1] === 'install')
        ) {
          // A fresh landing worktree has no postinstall outputs. Prepare it once before affected commands run.
          landingAffectedResults.push(
            await runOwnedAffected(
              ['bun', 'install', '--frozen-lockfile'],
              trainTree,
              logPath,
              gateEnvironment(process.env, o.stateDirectory),
            ),
          );
        }
        if (!landingAffectedResults.some((checked) => checked.status !== 'passed'))
          landingAffectedResults.push(
            ...(await settleOwnedCommands(
              affectedChecks.map((check) =>
                runOwnedAffected(check.command, trainTree, logPath, {
                  ...gateEnvironment(process.env, o.stateDirectory),
                  KERNEL_CHECK_AFFECTED: base,
                }),
              ),
            )),
          );
        const affectedResults = landingAffectedResults;
        for (const checked of affectedResults) {
          if (checked.status === 'unverified') {
            appendFileSync(logPath, `Affected test unverified (landing allowed): ${checked.command.join(' ')}\n`);
            continue;
          }
          if (checked.status === 'passed') continue;
          stage = 'gate';
          // A failure that names no test file (a setup or migration failure) has nothing bounded to compare on the
          // base: comparing it ran the whole kernel suite inside the train. Transport and storage failures are
          // already unverified, so what remains is refused with its output and no base run.
          if (!checked.failingFiles.length) {
            const tail = checked.output
              .split('\n')
              .filter((line) => line.trim())
              .slice(-20);
            affectedFailures.push(
              `${checked.command.join(' ')} failed without naming a test file:\n${tail.join('\n')}`,
            );
            result.failedCommand ??= [...checked.command];
            continue;
          }
          if (!baseTreeFiles) {
            baseTreeFiles = new Set(
              git(o.mainCheckout, 'ls-tree', '-r', '--full-tree', '--name-only', '-z', base)
                .split('\0')
                .filter(Boolean),
            );
          }
          const filesAtBase = baseTreeFiles;
          const baselineFiles = checked.failingFiles.filter((file) => filesAtBase.has(file));
          const introducedFiles = checked.failingFiles.filter((file) => !filesAtBase.has(file));
          if (!baselineFiles.length) {
            affectedFailures.push(...introducedFiles);
            result.failedCommand ??= [...checked.command];
            appendFileSync(
              logPath,
              'All affected-test failures name files absent from the base; no baseline run needed\n',
            );
            continue;
          }
          // A base compared with itself selects no affected tests, so the base runs the files that failed on the
          // branch by name. The whole suite cost a full kernel run inside the serial train on every landing, because
          // dev moves with each landing and a full base result was almost never reused.
          const baselineCommand = [...checked.command, ...baselineFiles];
          const key = `affected-test:${JSON.stringify(baselineCommand)}`;
          let baseline = o.queue.baseline(base, key);
          if (!baseline) {
            const baselineTree = resolve(o.worktreeRoot, `affected-base-${randomUUID()}`);
            git(o.mainCheckout, 'worktree', 'add', '--detach', baselineTree, base);
            try {
              appendFileSync(logPath, `Affected test baseline on ${base}: ${baselineCommand.join(' ')}\n`);
              const environment = {
                ...gateEnvironment(process.env, o.stateDirectory),
                KERNEL_CHECK_AFFECTED: '',
                KERNEL_CHECK_SKIP_STALE_CLEANUP: '1',
              };
              // As with promotion's narrowed gates, a fresh local worktree needs its installed tools.
              if (existsSync(join(baselineTree, 'package.json'))) {
                const installed = await runOwnedAffected(
                  ['bun', 'install', '--frozen-lockfile'],
                  baselineTree,
                  logPath,
                  environment,
                );
                if (installed.status !== 'passed')
                  throw new Error(`Affected-test baseline install failed: ${installed.output}`);
              }
              const measured = await runOwnedAffected(baselineCommand, baselineTree, logPath, environment);
              if (measured.status === 'unverified') {
                appendFileSync(logPath, 'Affected test baseline unverified (landing allowed)\n');
                continue;
              }
              baseline = { passed: measured.status === 'passed', output: measured.output, timedOut: false };
              o.queue.saveBaseline(base, key, baseline);
            } finally {
              git(o.mainCheckout, 'worktree', 'remove', '--force', baselineTree);
            }
          }
          o.fence.assertCurrent(request);
          if (target() !== base) break;
          const baseFiles = new Set(failingTestFiles(baseline.output));
          const added = [
            ...introducedFiles,
            ...baselineFiles.filter((file) => baseline.passed || !baseFiles.has(file)),
          ];
          if (added.length) {
            affectedFailures.push(...added);
            result.failedCommand ??= [...checked.command];
          } else appendFileSync(logPath, 'Base already shares the affected-test failures\n');
        }
        o.fence.assertCurrent(request);
        if (target() !== base || (controlPlane && !this.controlPlaneSnapshotMatches(releaseSnapshot!))) {
          if (controlPlane) retryMovedControlPlaneRefs();
          continue;
        }
        if (affectedFailures.length) {
          const report = `Affected tests introduced failures:\n${[...new Set(affectedFailures)].join('\n')}`;
          appendFileSync(logPath, `${report}\n`);
          result.firstFailure = {
            ...firstFailure(report),
            assertion: report,
            fingerprint: createHash('sha256').update(report).digest('hex'),
          };
          result.failsOnMain = false;
          result.stage = 'gate';
          return finish();
        }
        refreshManagerLanding();
        if (controlPlane) {
          stage = 'gate';
          custody?.capture(candidate, releaseSnapshot!);
          const proof = await this.verifyControlPlaneCandidate(
            trainTree,
            candidate,
            releaseSnapshot!,
            logPath,
            undefined,
            undefined,
            [],
            custody,
          );
          o.fence.assertCurrent(request);
          if (!proof.passed) {
            result.timedOut = proof.timedOut;
            result.firstFailure = firstFailure(proof.output);
            if (proof.failedCommand) result.failedCommand = [...proof.failedCommand];
            result.stage = 'gate';
            return finish();
          }
          if (proof.moved) {
            retryMovedControlPlaneRefs();
            continue;
          }
          lifecycleEvidence = proof.lifecycleEvidence;
          compatibilityCommand = proof.compatibilityCommand;
        }
        const configuredChecks =
          typeof o.integrationChecks === 'function' ? o.integrationChecks() : (o.integrationChecks ?? []);
        const integrationChecks = integrationChecksForFiles(result.changedFiles, configuredChecks);
        if (!skipDevChecks && !controlPlane && integratesIntoDev && integrationChecks.length) {
          stage = 'gate';
          appendFileSync(logPath, `\nIntegration check on ${candidate}, dev ${base}\n`);
          // The workspace typecheck covers only the workspaces this change can affect (scripts/typecheck.ts reads
          // TYPECHECK_CHANGED); a scoped result is a baseline only for the same change, so the key names it.
          const changed = result.changedFiles.join('\n');
          const commands = integrationChecks.map((check) =>
            check.command.join(' ').includes('scripts/typecheck.ts')
              ? ['env', `TYPECHECK_CHANGED=${changed}`, ...check.command]
              : check.command,
          );
          const checked = await runIntegrationChecks(commands, trainTree, logPath);
          assertCandidate(trainTree, candidate, 'dev integration checks', logPath);
          o.fence.assertCurrent(request);
          if (target() !== base) continue;
          const scoped = commands.some((command) => command[0] === 'env');
          const key = `integration-check:${JSON.stringify(integrationChecks)}${scoped ? `:${Bun.hash(changed).toString(16)}` : ''}`;
          // An integrated candidate is dev's next head, so its result is that head's baseline.
          o.queue.saveBaseline(candidate, key, checked);
          if (!checked.passed) {
            result.timedOut = checked.timedOut;
            result.firstFailure = firstFailure(checked.output);
            if (checked.failedCommand) result.failedCommand = [...checked.failedCommand];
            let baseline = o.queue.baseline(base, key);
            if (!baseline) {
              git(trainTree, 'reset', '--hard', base);
              git(trainTree, 'clean', '-fdx');
              appendFileSync(logPath, `\nIntegration check baseline on dev ${base}\n`);
              baseline = await runIntegrationChecks(commands, trainTree, logPath);
              assertCandidate(trainTree, base, 'dev integration check baseline', logPath);
              o.queue.saveBaseline(base, key, baseline);
            }
            o.fence.assertCurrent(request);
            if (target() !== base) continue;
            if (baseline.passed) {
              result.failsOnMain = false;
              result.stage = stage;
              return finish();
            }
            const added = newErrorLines(checked.output, baseline.output);
            if (added.length) {
              const report = `Errors that dev ${base} does not have:\n${added.join('\n')}`;
              appendFileSync(logPath, `${report}\n`);
              result.firstFailure = firstFailure(report);
              result.failsOnMain = false;
              result.stage = stage;
              return finish();
            }
            appendFileSync(logPath, 'dev already fails the integration check, with the same errors\n');
          }
        }
        // A failed check may leave the train tree on the dev baseline for comparison. Acceptance must always run on
        // the merged candidate, even when dev already has the same integration-check failure.
        if (git(trainTree, 'rev-parse', 'HEAD') !== candidate) {
          git(trainTree, 'reset', '--hard', candidate);
          git(trainTree, 'clean', '-fdx');
        }
        if (workspace && !skipDevChecks) {
          stage = 'gate';
          let failed = false;
          for (const task of sharedTasks) {
            refreshManagerLanding();
            if (request.managerLanding && task.id === request.taskId) {
              appendFileSync(
                logPath,
                `Retained worker acceptance for ${task.id} attempt ${request.attempt} at ${request.managerLanding.acceptedCommit}: ${request.managerLanding.acceptanceCommand.join(' ')}\n`,
              );
              continue;
            }
            appendFileSync(
              logPath,
              `Shared workspace acceptance for ${task.id}: ${task.brief.acceptance.command.join(' ')}\n`,
            );
            const checked = await runGate(task.brief.acceptance.command, trainTree, logPath);
            assertCandidate(trainTree, candidate, `shared workspace acceptance ${task.id}`, logPath);
            o.fence.assertCurrent(request);
            if (target() !== base) break;
            if (!checked.passed) {
              result.stage = 'gate';
              result.firstFailure = firstFailure(checked.output);
              result.failedCommand = task.brief.acceptance.command;
              result.timedOut = checked.timedOut;
              attributeFailure(result, [task]);
              failed = true;
              break;
            }
          }
          if (target() !== base) continue;
          if (failed) return finish();
          if (git(trainTree, 'rev-parse', 'HEAD') !== candidate)
            throw new Error('Acceptance changed the candidate commit');
        }
        if ((!controlPlane || integratesIntoDev) && !workspace && !skipDevChecks) {
          stage = 'gate';
          refreshManagerLanding();
          if (request.managerLanding) {
            appendFileSync(
              logPath,
              `Retained worker acceptance for ${request.taskId} attempt ${request.attempt} at ${request.managerLanding.acceptedCommit}: ${request.managerLanding.acceptanceCommand.join(' ')}\n`,
            );
          } else {
            appendFileSync(
              logPath,
              `\nAcceptance on ${candidate}, ${integratesIntoDev ? 'dev' : 'main'} ${base}: ${request.gate.join(' ')}\n`,
            );
            const gated = await runGate(request.gate, trainTree, logPath);
            assertCandidate(trainTree, candidate, 'acceptance', logPath);
            // A gate on an old target is never authoritative, including a red gate.
            o.fence.assertCurrent(request);
            if (target() !== base) continue;
            if (!gated.passed) {
              result.timedOut = gated.timedOut;
              result.firstFailure = firstFailure(gated.output);
              result.failedCommand = [...request.gate];
              const key = `acceptance:${JSON.stringify([o.gateIdentity ?? '', request.gate])}`;
              let baseline = o.queue.baseline(base, key);
              if (!baseline) {
                git(trainTree, 'reset', '--hard', base);
                git(trainTree, 'clean', '-fdx');
                baseline = await runGate(request.gate, trainTree, logPath);
                assertCandidate(trainTree, base, 'acceptance baseline', logPath);
                o.queue.saveBaseline(base, key, baseline);
              }
              o.fence.assertCurrent(request);
              if (target() !== base) continue;
              result.failsOnMain =
                !baseline.passed && firstFailure(baseline.output).fingerprint === result.firstFailure.fingerprint;
              if (result.failsOnMain)
                appendFileSync(
                  logPath,
                  `${integratesIntoDev ? 'Acceptance failure is pre-existing on dev' : 'Acceptance failure is pre-existing on main'}\n`,
                );
              result.stage = stage;
              return finish();
            }
          }
        }
        stage = 'merge';
        const integrationCommits = git(trainTree, 'rev-list', '--reverse', `${base}..${candidate}`)
          .split('\n')
          .filter(Boolean);
        const planner = o.fence as AttemptFence & {
          planIntegration?: (ref: AttemptRef, base: string, commit: string, commits: readonly string[]) => void;
        };
        planner.planIntegration?.(
          request,
          base,
          candidate,
          workspace ? taskCommits(sharedStore!.task(request.taskId), tip) : integrationCommits,
        );
        o.queue.candidate(entry.id, candidate);
        let preparedControlPlaneRelease: PreparedControlPlaneRelease | undefined;
        if (controlPlane) {
          custody?.checkpoint();
          if (!releaseSnapshot || !lifecycleEvidence || !compatibilityCommand)
            throw new Error('Control-plane candidate reached publication without complete gate evidence');
          if (target() !== base || !this.controlPlaneSnapshotMatches(releaseSnapshot)) {
            retryMovedControlPlaneRefs();
            continue;
          }
          const release = this.prepareControlPlaneRelease(
            request,
            releaseSnapshot,
            candidate,
            lifecycleEvidence,
            compatibilityCommand,
            logPath,
          );
          if (release.conflicts?.length) {
            const files = [...release.conflicts].sort();
            const sourceBranch = release.sourceBranch ?? mainBranch;
            const targetBranch = release.targetBranch ?? 'unknown';
            const cause = release.cause ?? 'Git reported a merge conflict without a cause';
            const report =
              `Control-plane release conflict from ${sourceBranch} into ${targetBranch}; ` +
              `files=[${files.join(', ')}]; cause=${cause}`;
            appendFileSync(logPath, `Candidate ${candidate} was not published.\n${report}\n`);
            result.stage = 'rebase';
            result.conflictedFiles = files;
            const targetHead =
              targetBranch === releaseSnapshot.stabilizeBranch
                ? releaseSnapshot.stabilizeHead
                : releaseSnapshot.devHead;
            const conflictContext = makeRebaseConflictContext(targetHead, request.workerCommit ?? tip, files);
            if (conflictContext) result.rebaseConflict = conflictContext;
            result.firstFailure = {
              ...firstFailure(report),
              assertion: report,
              fingerprint: createHash('sha256')
                .update(JSON.stringify({ sourceBranch, targetBranch, files, cause }))
                .digest('hex'),
            };
            const repeatedConflict = this.notifyControlPlaneConflict(
              request.taskId,
              recorded.manager,
              sourceBranch,
              candidate,
              targetBranch,
              files,
              cause,
              conflictContext,
            );
            if (repeatedConflict) result.controlPlaneConflictRepeated = true;
            return finish();
          }
          if (!release.prepared) {
            retryMovedControlPlaneRefs();
            continue;
          }
          preparedControlPlaneRelease = release.prepared;
          preparedControlPlaneRelease.record.source = { branch: request.branch, commit: tip };
        }
        if (target() !== base || (controlPlane && !this.controlPlaneSnapshotMatches(releaseSnapshot!))) {
          if (controlPlane) retryMovedControlPlaneRefs();
          continue;
        }
        if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
          throw new Error('Main checkout HEAD changed while integrating');
        const advanced = o.fence.commitMerge(request, () => {
          // Retry uses the same BEGIN IMMEDIATE lock through this check, Git and task-state publication.
          if (target() !== base) return '';
          if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
            throw new Error('Main checkout HEAD changed');
          if (controlPlane) {
            o.beforeIntegrationAdvance?.();
            o.beforePromotionAdvance?.();
            custody?.checkpoint();
            if (
              target() !== base ||
              !preparedControlPlaneRelease ||
              !this.controlPlaneSnapshotMatches(preparedControlPlaneRelease.snapshot)
            )
              return '';
            this.writeControlPlaneRecord(request, preparedControlPlaneRelease.record);
            if (!this.publishControlPlaneRelease(preparedControlPlaneRelease)) return '';
            this.syncMainCheckout(mainBranch, [preparedControlPlaneRelease.record.mainExpected, candidate]);
            if (!this.controlPlaneRecordPublished(preparedControlPlaneRelease.record))
              throw new Error('Control-plane release refs changed before the landing outcome was recorded');
          } else if (integratesIntoDev) {
            o.beforeIntegrationAdvance?.();
            assertCandidate(trainTree, candidate, 'dev root typecheck before ref advance', logPath);
            try {
              git(o.mainCheckout, 'update-ref', targetRef, candidate, base);
            } catch (error) {
              if (target() !== base) return '';
              throw error;
            }
          } else if (o.merge) o.merge(o.mainCheckout, candidate);
          else git(o.mainCheckout, 'merge', '--ff-only', '--no-edit', candidate);
          return candidate;
        });
        if (!advanced) {
          if (controlPlane) retryMovedControlPlaneRefs();
          continue;
        }
        if (workspace) {
          workspace.integrated(recorded.workspace!.module, candidate);
          try {
            await workspace.withLaunch(recorded.workspace!.module, () =>
              workspace.syncIdle(recorded.workspace!.module),
            );
          } catch (error) {
            appendFileSync(logPath, `Idle workspace dev merge deferred: ${error}\n`);
          }
        }
        result.passed = true;
        result.stage = 'merge';
        result.mergedCommit = candidate;
        this.notifyOwnersOfOutsideChanges(
          request,
          [
            ...new Set([
              ...outsideScope(
                (workspace
                  ? taskChangedPaths(sharedStore!.task(request.taskId), tip)
                  : (result.changedFiles ?? [])
                ).filter((path) => !derivedForPath(path, derivedFiles).length),
                request.declaredPaths,
              ),
              ...markdownUnionFiles(logPath),
            ]),
          ],
          candidate,
          targetBranch,
          logPath,
        );
        if (controlPlane) await this.propagateControlPlaneCommit(candidate, request.taskId, recorded.manager, logPath);
        else if (stabilize)
          await this.mergeStabilizedCommitIntoDev(candidate, trainTree, request.taskId, recorded.manager, logPath);
        return finish();
      }
    } catch (error) {
      if (custody?.signal.aborted || error instanceof StaleAttemptError) throw error;
      const message = String(error);
      appendFileSync(logPath, `${message}\n`);
      result.stage = stage;
      if (stage === 'rebase' && added) {
        const conflicts = canonicalConflictPaths(unmergedFiles(trainTree));
        if (conflicts.length) {
          result.conflictedFiles = conflicts;
          const context = makeRebaseConflictContext(activeTargetHead, workerCommit, conflicts);
          if (context) result.rebaseConflict = context;
        }
      }
      result.firstFailure = firstFailure(message);
      return finish();
    } finally {
      result.hostMs = Date.now() - started;
      if (added) {
        try {
          git(trainTree, 'rebase', '--abort');
        } catch {}
        try {
          git(trainTree, 'merge', '--abort');
        } catch {}
        try {
          prepareRemoval?.();
          git(o.mainCheckout, 'worktree', 'remove', '--force', trainTree);
        } catch (error) {
          // Retain the tree and exact cleanup failure without replacing a failed proof or a committed outcome.
          appendFileSync(logPath, `Train tree cleanup deferred: ${trainTree}: ${error}\n`);
        }
      }
    }
  }

  private notifyDevTypecheckFailure(
    taskId: string,
    managerId: string | undefined,
    command: readonly string[],
    output: string,
    candidate: string,
    logPath: string,
  ): void {
    const summary =
      `Task ${taskId} could not advance dev candidate ${candidate}: root typecheck command ${command.join(' ')} failed. ` +
      `Compiler output: ${output.slice(-6000)}. Full log: ${logPath}`.replace(/[\r\n]+/g, ' ');
    const supermanager =
      this.options.supermanager ??
      localBranchSettings(this.options.mainCheckout).supermanager ??
      defaults.integration.supermanager;
    const managers = [...new Set([managerId, supermanager].filter((id): id is string => Boolean(id)))];
    const shared = (this.options.fence as AttemptFence & { db?: Database }).db;
    const path = join(this.options.stateDirectory, 'goal.sqlite');
    const owned = shared || !existsSync(path) ? undefined : openDb(path);
    const db = shared ?? owned;
    if (!db) return;
    try {
      const inbox = new SqliteManagerInbox(
        db,
        this.options.inboxDirectory ?? join(this.options.stateDirectory, 'inboxes'),
      );
      for (const manager of managers)
        inbox.deliver({ managerId: manager, taskId, kind: 'instruction', evidencePath: logPath, summary });
    } finally {
      owned?.close();
    }
  }

  /** Publish a checked control-plane commit through the candidate branches without moving a ref past its current head. */
  private async propagateControlPlaneCommit(
    mainCommit: string,
    taskId: string,
    managerId: string | undefined,
    logPath: string,
  ): Promise<void> {
    const mainBranch = this.options.mainBranch ?? 'main';
    const stabilizeBranch =
      this.options.stabilizeBranch ?? localBranchSettings(this.options.mainCheckout).stabilizeBranch ?? 'stabilize';
    const devBranch = this.options.integrationBranch ?? 'dev';
    if (!this.commitIsAncestor(mainCommit, mainBranch)) {
      appendFileSync(
        logPath,
        `Cannot propagate control-plane commit ${mainCommit}: it is no longer on ${mainBranch}.\n`,
      );
      return;
    }

    const stableRef = `refs/heads/${stabilizeBranch}`;
    const stableHead = spawnSync('git', ['rev-parse', '--verify', stableRef], {
      cwd: this.options.mainCheckout,
      encoding: 'utf8',
    });
    let devSource = mainCommit;
    let sourceBranch = mainBranch;
    if (stableHead.status === 0) {
      const merged = await this.mergeCommitIntoBranch(mainCommit, mainBranch, stabilizeBranch, logPath);
      if (merged.conflicts) {
        this.notifyControlPlaneConflict(taskId, managerId, mainBranch, mainCommit, stabilizeBranch, merged.conflicts);
        return;
      }
      if (merged.error) {
        appendFileSync(logPath, `Cannot merge ${mainBranch} into ${stabilizeBranch}: ${merged.error}\n`);
        return;
      }
      if (!merged.commit) return;
      devSource = merged.commit;
      sourceBranch = stabilizeBranch;
    } else
      appendFileSync(
        logPath,
        `No ${stabilizeBranch} branch exists; merging ${mainBranch} directly into ${devBranch}.\n`,
      );

    const merged = await this.mergeCommitIntoBranch(devSource, sourceBranch, devBranch, logPath, spawnSync, {
      taskId,
      ...(managerId === undefined ? {} : { managerId }),
    });
    if (merged.conflicts) {
      this.notifyControlPlaneConflict(taskId, managerId, sourceBranch, devSource, devBranch, merged.conflicts);
      return;
    }
    if (merged.error) appendFileSync(logPath, `Cannot merge ${sourceBranch} into ${devBranch}: ${merged.error}\n`);
  }

  /** Build a non-fast-forward merge away from the checkout, then compare-and-swap the target ref. */
  private async mergeCommitIntoBranch(
    sourceCommit: string,
    sourceBranch: string,
    targetBranch: string,
    logPath: string,
    runSync: SpawnText = spawnSync,
    owner?: { taskId: string; managerId?: string },
  ): Promise<{ commit?: string; conflicts?: string[]; error?: string }> {
    const checkout = this.options.mainCheckout;
    const targetRef = `refs/heads/${targetBranch}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const targetResult = runSync('git', ['rev-parse', '--verify', targetRef], {
        cwd: checkout,
        encoding: 'utf8',
      });
      if (targetResult.status !== 0) {
        const detail = targetResult.stderr?.trim() || targetResult.error?.message || 'missing ref';
        return {
          error: `branch ${targetBranch} does not exist: ${detail}`,
        };
      }
      const targetHead = targetResult.stdout?.trim() ?? '';
      if (isAncestor(checkout, sourceCommit, targetHead)) return { commit: targetHead };

      const tree = resolve(this.options.worktreeRoot, `control-plane-merge-${randomUUID()}`);
      mkdirSync(resolve(this.options.worktreeRoot), { recursive: true });
      try {
        git(checkout, 'worktree', 'add', '--detach', tree, targetHead);
        const merged = runSync(
          'git',
          ['merge', '--no-ff', '--no-edit', '-m', `Merge ${sourceBranch} into ${targetBranch}`, sourceCommit],
          { cwd: tree, encoding: 'utf8' },
        );
        const output = `${merged.stdout ?? ''}${merged.stderr ?? ''}` || merged.error?.message || '';
        if (merged.status !== 0) {
          const conflicts = git(tree, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
          try {
            git(tree, 'merge', '--abort');
          } catch {}
          appendFileSync(
            logPath,
            `Merge ${sourceBranch} ${sourceCommit} into ${targetBranch} aborted${conflicts.length ? ` on ${conflicts.join(', ')}` : ''}: ${output}\n`,
          );
          return conflicts.length ? { conflicts } : { error: output.trim() || 'merge failed without conflict paths' };
        }

        const commit = git(tree, 'rev-parse', 'HEAD');
        if (targetBranch === (this.options.integrationBranch ?? 'dev')) {
          if (
            !existsSync(join(tree, 'node_modules')) &&
            existsSync(join(tree, 'bun.lock')) &&
            existsSync(join(tree, 'package.json'))
          )
            installShared(tree);
          const { command, result } = await this.checkDevCandidate(tree, targetHead, commit, logPath);
          if (!result.passed) {
            const output = result.output || 'Root typecheck failed without compiler output';
            appendFileSync(logPath, `Required root typecheck failed before advancing ${targetBranch}:\n${output}\n`);
            if (owner) this.notifyDevTypecheckFailure(owner.taskId, owner.managerId, command, output, commit, logPath);
            return { error: `Root typecheck failed before advancing ${targetBranch}: ${output}` };
          }
        }
        this.options.beforePromotionAdvance?.();
        try {
          if (targetBranch === (this.options.integrationBranch ?? 'dev'))
            assertCandidateIntegrity(
              tree,
              commit,
              'dev root typecheck before ref advance',
              logPath,
              this.options.runCandidateGit,
            );
          git(checkout, 'update-ref', targetRef, commit, targetHead);
          return { commit };
        } catch (error) {
          const current = spawnSync('git', ['rev-parse', '--verify', targetRef], {
            cwd: checkout,
            encoding: 'utf8',
          });
          if (current.status === 0 && current.stdout.trim() !== targetHead) {
            appendFileSync(logPath, `${targetBranch} moved during merge; retrying against ${current.stdout.trim()}.\n`);
            continue;
          }
          return { error: String(error) };
        }
      } catch (error) {
        return { error: String(error) };
      } finally {
        try {
          git(checkout, 'worktree', 'remove', '--force', tree);
        } catch {}
      }
    }
    return { error: `${targetBranch} moved during all five merge attempts` };
  }

  private notifyControlPlaneConflict(
    taskId: string,
    managerId: string | undefined,
    sourceBranch: string,
    sourceCommit: string,
    targetBranch: string,
    files: readonly string[],
    cause = 'Git reported a merge conflict',
    conflictContext?: RebaseConflictContext,
  ): boolean {
    const details = {
      sourceBranch,
      targetBranch,
      files: [...files].sort(),
      cause,
      ...(conflictContext
        ? { targetHead: conflictContext.targetHead, workerCommit: conflictContext.workerCommit }
        : {}),
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(details)).digest('hex');
    const taskRecordPath = this.controlPlaneConflictPath(taskId);
    let previousTaskFingerprint: string | undefined;
    try {
      const previous = JSON.parse(readFileSync(taskRecordPath, 'utf8')) as {
        taskId?: string;
        fingerprint?: string;
      };
      if (previous.taskId === taskId) previousTaskFingerprint = previous.fingerprint;
    } catch {
      // A missing or invalid task record permits a new bounded conflict attempt.
    }
    if (previousTaskFingerprint === fingerprint) return true;

    mkdirSync(this.options.stateDirectory, { recursive: true });
    const taskTemporary = `${taskRecordPath}.${randomUUID()}.tmp`;
    writeFileSync(taskTemporary, `${JSON.stringify({ taskId, fingerprint, ...details }, null, 2)}\n`, { mode: 0o600 });
    renameSync(taskTemporary, taskRecordPath);

    const recordPath = join(this.options.stateDirectory, 'control-plane-conflict.json');
    let previousFingerprint: string | undefined;
    try {
      previousFingerprint = (JSON.parse(readFileSync(recordPath, 'utf8')) as { fingerprint?: string }).fingerprint;
    } catch {
      // A missing or invalid record permits one new notice.
    }
    if (previousFingerprint === fingerprint) return false;
    const temporary = `${recordPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ taskId, fingerprint, ...details }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, recordPath);
    const summary =
      `Task ${taskId} ${sourceBranch} ${sourceCommit} conflicts with ${targetBranch}: ${files.join(', ')}. ` +
      `Cause: ${cause}. ${targetBranch} was left unchanged.`.replace(/[\r\n]+/g, ' ');
    const supermanager =
      this.options.supermanager ??
      localBranchSettings(this.options.mainCheckout).supermanager ??
      defaults.integration.supermanager;
    const managers = [...new Set([managerId, supermanager].filter((id): id is string => Boolean(id)))];
    const shared = (this.options.fence as AttemptFence & { db?: Database }).db;
    const path = join(this.options.stateDirectory, 'goal.sqlite');
    const owned = shared || !existsSync(path) ? undefined : openDb(path);
    const db = shared ?? owned;
    if (!db) return false;
    try {
      const inbox = new SqliteManagerInbox(
        db,
        this.options.inboxDirectory ?? join(this.options.stateDirectory, 'inboxes'),
      );
      for (const manager of managers) inbox.deliver({ managerId: manager, taskId, kind: 'spec-conflict', summary });
    } finally {
      owned?.close();
    }
    return false;
  }

  /** Merge the new stabilize commit into dev. A conflict leaves stabilize advanced and wakes both managers. */
  private async mergeStabilizedCommitIntoDev(
    candidate: string,
    trainTree: string,
    taskId: string,
    managerId: string | undefined,
    logPath: string,
  ): Promise<void> {
    const devBranch = this.options.integrationBranch ?? 'dev';
    const devRef = `refs/heads/${devBranch}`;
    try {
      if (this.commitIsAncestor(candidate, devBranch)) {
        // Merged, by the train or by hand: a later conflict is news again.
        rmSync(join(this.options.stateDirectory, 'stabilize-conflict.json'), { force: true });
        return;
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const expected = this.ensureBranch(devBranch);
        try {
          git(trainTree, 'merge', '--abort');
        } catch {
          /* The worktree is not merging. */
        }
        git(trainTree, 'reset', '--hard', expected);
        git(trainTree, 'clean', '-fdx');
        try {
          git(trainTree, 'merge', '--no-ff', '--no-edit', candidate);
        } catch (error) {
          const files = unmergedFiles(trainTree);
          if (files.length && this.resolveGeneratedConflicts(trainTree, files, logPath)) {
            appendFileSync(
              logPath,
              `Stabilize ${candidate} merged into ${devBranch} regenerating generated conflicts: ${files.join(', ')}\n`,
            );
          } else if (files.length && this.resolveImportConflicts(trainTree, files)) {
            appendFileSync(
              logPath,
              `Stabilize ${candidate} merged into ${devBranch} resolving import-only and insert-only conflicts: ${files.join(', ')}\n`,
            );
          } else {
            try {
              git(trainTree, 'merge', '--abort');
            } catch {
              /* Already cleared. */
            }
            appendFileSync(
              logPath,
              `Stabilize ${candidate} did not merge into ${devBranch}: ${files.join(', ') || error}\n`,
            );
            this.notifyStabilizeConflict(taskId, managerId, candidate, files);
            return;
          }
        }
        const merged = git(trainTree, 'rev-parse', 'HEAD');
        if (merged === expected) return;
        if (
          !existsSync(join(trainTree, 'node_modules')) &&
          existsSync(join(trainTree, 'bun.lock')) &&
          existsSync(join(trainTree, 'package.json'))
        )
          installShared(trainTree);
        try {
          const { command, result } = await this.checkDevCandidate(trainTree, expected, merged, logPath);
          if (!result.passed) {
            const output = result.output || 'Root typecheck failed without compiler output';
            appendFileSync(logPath, `Required root typecheck failed before advancing ${devBranch}:\n${output}\n`);
            this.notifyDevTypecheckFailure(taskId, managerId, command, output, merged, logPath);
            return;
          }
        } catch (error) {
          const output = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          this.notifyDevTypecheckFailure(
            taskId,
            managerId,
            rootTypecheckCommand(changedFiles(trainTree, expected)),
            output,
            merged,
            logPath,
          );
          appendFileSync(logPath, `Required root typecheck could not validate ${merged}: ${output}\n`);
          return;
        }
        try {
          git(this.options.mainCheckout, 'update-ref', devRef, merged, expected);
          rmSync(join(this.options.stateDirectory, 'stabilize-conflict.json'), { force: true });
          return;
        } catch (error) {
          if (git(this.options.mainCheckout, 'rev-parse', devRef) === expected) throw error;
          if (attempt === 4) throw new Error(`dev moved while merging stabilize ${candidate}`);
        }
      }
    } catch (error) {
      appendFileSync(logPath, `${error}\n`);
      this.notifyStabilizeConflict(taskId, managerId, candidate, []);
    }
  }

  private commitIsAncestor(commit: string, branch: string): boolean {
    try {
      git(this.options.mainCheckout, 'merge-base', '--is-ancestor', commit, branch);
      return true;
    } catch {
      return false;
    }
  }

  private ensureBranch(branch: string): string {
    const reference = `refs/heads/${branch}`;
    try {
      return git(this.options.mainCheckout, 'rev-parse', '--verify', reference);
    } catch {
      const main = git(
        this.options.mainCheckout,
        'rev-parse',
        '--verify',
        `refs/heads/${this.options.mainBranch ?? 'main'}`,
      );
      try {
        git(this.options.mainCheckout, 'branch', '--', branch, main);
      } catch (error) {
        try {
          return git(this.options.mainCheckout, 'rev-parse', '--verify', reference);
        } catch {
          throw error;
        }
      }
      return main;
    }
  }

  /** Finish a merge whose every conflict is two sides adding imports; false leaves the merge for a person. */
  private resolveImportConflicts(tree: string, files: readonly string[]): boolean {
    const formatCommand = this.options.formatCommand ?? [
      resolve(this.options.mainCheckout, 'node_modules/.bin/oxfmt'),
      ...FORMAT_FLAGS,
    ];
    if (!resolveMechanicalConflicts(tree, files, formatCommand, 'insertions', 3)) return false;
    git(tree, 'add', '--', ...files);
    git(tree, '-c', 'core.editor=true', 'commit', '--no-edit');
    return true;
  }

  /** Resolve a generated-only merge by keeping the target side and regenerating every declared output. */
  private resolveGeneratedConflicts(tree: string, conflicts: readonly string[], logPath: string): boolean {
    const files = this.options.derivedFiles ?? defaultDerivedFiles;
    if (!conflicts.length || conflicts.some((path) => !derivedForPath(path, files).length)) return false;

    const commands = new Map<string, string[]>();
    for (const path of conflicts) {
      git(tree, 'checkout', '--ours', '--', path);
      for (const file of derivedForPath(path, files)) commands.set(JSON.stringify(file.command), file.command);
    }
    try {
      ensureDerivedDependencies(tree, logPath, commands.values());
    } catch {
      return false;
    }
    for (const command of commands.values()) {
      const result = spawnSync(command[0]!, command.slice(1), { cwd: tree, encoding: 'utf8' });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${tree})\n${output}`);
      if (result.status !== 0) return false;
    }
    const changedGenerated = changedWorkingFiles(tree).filter((path) => derivedForPath(path, files).length > 0);
    stagePaths(tree, new Set([...conflicts, ...changedGenerated]));
    git(tree, '-c', 'core.editor=true', 'commit', '--no-edit');
    return true;
  }

  /** Combined main cohorts need separate exact-source owner authority for every additional file. */
  private checkControlPlaneScope(files: readonly string[], request: LandingRequest, logPath: string): void {
    this.checkScope(files, request, logPath);
    const outside = outsideScope(files, request.declaredPaths);
    if (outside.length)
      throw new Error(`Control-plane source needs native owning-manager scope approval: ${outside.join(', ')}`);
  }

  /**
   * Declared paths say where the work is expected, not a fence: a worker may change other files its acceptance or a
   * defect blocking it needs, and they are logged. Only risk areas the brief did not declare stay closed.
   */
  private checkScope(files: readonly string[], request: LandingRequest, logPath: string): void {
    const outside = outsideScope(files, request.declaredPaths);
    if (!outside.length) return;
    const protectedPaths = request.protectedPaths ?? [];
    const refused = protectedPaths.length ? outside.filter((path) => !outsideScope([path], protectedPaths).length) : [];
    if (refused.length) throw new Error(`Changes in undeclared risk areas: ${refused.join(', ')}`);
    appendFileSync(logPath, `Changed outside declared paths (allowed): ${outside.join(', ')}\n`);
  }

  /**
   * A worker may change files outside its declared paths, and its landing runs only its own acceptance, so another
   * Goal's tests may break without that Goal knowing why. Each Goal whose tasks declare such a file most specifically
   * is told at once, with the commit. A file the landing task's own Goal declares most specifically is its own.
   */
  private notifyOwnersOfOutsideChanges(
    request: LandingRequest,
    files: readonly string[],
    commit: string,
    branch: string,
    logPath: string,
  ): void {
    const shared = (this.options.fence as AttemptFence & { db?: Database }).db;
    const path = join(this.options.stateDirectory, 'goal.sqlite');
    const owned = shared || !existsSync(path) ? undefined : openDb(path);
    const db = shared ?? owned;
    if (!db) return;
    try {
      // A retry may have resolved the Markdown before the train saw it. Carry that evidence into the landing
      // log so batch and single landings send the same notice, including to this task's own Goal.
      const unionFiles = new Set(markdownUnionFiles(logPath));
      for (const row of db
        .query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt<=?')
        .all(request.taskId, request.attempt) as { body: string }[]) {
        const attempt = JSON.parse(row.body) as { logPath: string };
        for (const file of markdownUnionFiles(`${attempt.logPath}.rebase`)) {
          if (unionFiles.has(file)) continue;
          unionFiles.add(file);
          appendFileSync(logPath, `Rebase resolved mechanical conflicts: ${file}; Markdown union: ${file}\n`);
        }
      }
      const noticedFiles = [...new Set([...files, ...unionFiles])];
      if (!noticedFiles.length) return;
      type Row = { id: string; state?: string; brief?: { goal?: string; manager?: string; paths?: string[] } };
      const tasks = (db.query('SELECT body FROM worker_tasks').all() as { body: string }[])
        .map((row) => JSON.parse(row.body) as Row)
        .filter((task) => task.state !== 'cancelled' && task.brief?.goal && task.brief.paths?.length);
      const own = tasks.find((task) => task.id === request.taskId)?.brief?.goal;
      const literal = (pattern: string) => pattern.split(/[*?[{]/, 1)[0]!.length;
      const byManager = new Map<string, string[]>();
      for (const file of noticedFiles) {
        let best = -1;
        let owners = new Set<string>();
        let goals = new Set<string>();
        for (const task of tasks) {
          for (const pattern of task.brief!.paths!) {
            if (!matchesPath(file, [pattern])) continue;
            const specificity = literal(pattern);
            if (specificity > best) {
              best = specificity;
              owners = new Set();
              goals = new Set();
            }
            if (specificity === best) {
              owners.add(task.brief!.manager ?? task.brief!.goal!);
              goals.add(task.brief!.goal!);
            }
          }
        }
        if (own && goals.has(own) && !unionFiles.has(file)) continue;
        for (const manager of owners) byManager.set(manager, [...(byManager.get(manager) ?? []), file]);
      }
      if (!byManager.size) return;
      const inbox = new SqliteManagerInbox(
        db,
        this.options.inboxDirectory ?? join(this.options.stateDirectory, 'inboxes'),
      );
      for (const [manager, changed] of byManager) {
        const unions = changed.filter((file) => unionFiles.has(file));
        const outside = changed.filter((file) => !unionFiles.has(file));
        const summary = (
          `Task ${request.taskId}${own ? ` (${own})` : ''} ` +
          (outside.length
            ? `changed files your tasks declare, outside its own paths, now on ${branch} ${commit}: ${outside.join(', ')}. Its landing ran only its own acceptance: check these against your tests.`
            : `landed on ${branch} ${commit}.`) +
          (unions.length ? ` Markdown union: ${unions.join(', ')}. Review section ordering.` : '')
        ).replace(/[\r\n]+/g, ' ');
        inbox.deliver({ managerId: manager, taskId: request.taskId, kind: 'instruction', summary });
        appendFileSync(logPath, `Told ${manager} of changes to its files: ${changed.join(', ')}\n`);
      }
    } finally {
      owned?.close();
    }
  }

  private notifyStabilizeConflict(
    taskId: string,
    managerId: string | undefined,
    commit: string,
    files: readonly string[],
  ): void {
    // The same unresolved conflict comes back with every later integration; one notice per conflict is enough, and the
    // watchdog reports a stabilize branch that stays out of dev.
    const record = join(this.options.stateDirectory, 'stabilize-conflict.json');
    const key = [...files].sort().join('\n');
    try {
      if (existsSync(record) && (JSON.parse(readFileSync(record, 'utf8')) as { key?: string }).key === key) return;
    } catch {
      /* Notify again rather than never. */
    }
    writeFileSync(record, JSON.stringify({ key, taskId, commit }));
    const summary = `Task ${taskId} stabilize ${commit} conflicts with dev: ${files.join(', ')}`.replace(
      /[\r\n]+/g,
      ' ',
    );
    const supermanager =
      this.options.supermanager ??
      localBranchSettings(this.options.mainCheckout).supermanager ??
      defaults.integration.supermanager;
    const managers = [...new Set([managerId, supermanager].filter((id): id is string => Boolean(id)))];
    const shared = (this.options.fence as AttemptFence & { db?: Database }).db;
    const path = join(this.options.stateDirectory, 'goal.sqlite');
    const owned = shared || !existsSync(path) ? undefined : openDb(path);
    const db = shared ?? owned;
    if (!db) return;
    try {
      const inbox = new SqliteManagerInbox(
        db,
        this.options.inboxDirectory ?? join(this.options.stateDirectory, 'inboxes'),
      );
      for (const manager of managers) inbox.deliver({ managerId: manager, taskId, kind: 'spec-conflict', summary });
    } finally {
      owned?.close();
    }
  }

  private assertLegacyControlPlaneGeneration(
    store: WorkerStore,
    request: LandingRequest,
    acceptedCommit: string,
  ): void {
    const task = store.task(request.taskId);
    // Before identity snapshots existed, native requests and immutable brief files carried this generation.
    const requested = store.events(request.taskId, request.attempt).find((event) => event.kind === 'landing-requested');
    const authorized = store
      .events(request.taskId, request.attempt)
      .findLast((event) => event.kind === 'manager-landing-authorized');
    const { managerLanding: _authorization, ...original } = request;
    const priorRequest = requested ? (JSON.parse(requested.body) as LandingRequest) : undefined;
    if (priorRequest?.managerLanding) delete priorRequest.managerLanding;
    // The original settlement names workerCommit. Older manager authorization rebuilt the request
    // without that optional field. Accept that existing representation only when the original source
    // itself equals the immutable manager-accepted commit; never substitute a guessed identity.
    if (priorRequest?.workerCommit && !original.workerCommit) {
      if (priorRequest.workerCommit !== acceptedCommit)
        throw new Error('Legacy readmission original source differs from accepted source');
      delete priorRequest.workerCommit;
    }
    if (
      !priorRequest ||
      !isDeepStrictEqual(priorRequest, original) ||
      !authorized ||
      !isDeepStrictEqual(JSON.parse(authorized.body), request.managerLanding) ||
      readFileSync(task.briefPath, 'utf8') !== task.brief.markdown
    )
      throw new Error('Legacy readmission contract/request generation is not exact');
  }

  /** Historical generations have immutable objects and receipts, not current branch/attempt fences. */
  private historicalControlPlaneIdentity(
    store: WorkerStore,
    previous: ControlPlaneBatchJournal,
    member: ControlPlaneBatchSource,
  ): string {
    const entry = this.options.queue.entry(member);
    if (
      !entry ||
      entry.batchId !== previous.batchId ||
      entry.outcome ||
      entry.delivered ||
      entry.candidate ||
      entry.request.managerLanding?.managerId !== previous.manifest.managerId ||
      entry.request.managerLanding.acceptedCommit !== member.acceptedCommit ||
      (entry.request.workerCommit && entry.request.workerCommit !== member.acceptedCommit)
    )
      throw new Error('Historical cohort request is processed, published, changed or claimed elsewhere');
    if (git(this.options.mainCheckout, 'rev-parse', `${member.acceptedCommit}^{commit}`) !== member.acceptedCommit)
      throw new Error('Historical accepted source object is unavailable');
    const published = this.readControlPlaneRecord(entry.request);
    if (published && this.controlPlaneRecordPublished(published))
      throw new Error('Prior published release record is immutable');
    const saved = previous.identities?.[member.taskId];
    if (saved) {
      const identity = JSON.parse(saved) as { request: LandingRequest; brief: Task['brief'] };
      if (!isDeepStrictEqual(identity.request, entry.request) || identity.brief.manager !== previous.manifest.managerId)
        throw new Error('Historical request/contract generation changed');
      return saved;
    }
    // Public retries retain brief files and hash links. Reconstruct only this exact historical generation.
    let markdown = readFileSync(join(this.options.stateDirectory, 'briefs', `${member.taskId}.md`), 'utf8');
    for (const attempt of store.attempts(member.taskId).filter((value) => value.attempt <= member.attempt)) {
      if (!attempt.newBriefHash) continue;
      if (attempt.previousBriefHash !== controlPlaneBriefHash(markdown))
        throw new Error('Historical brief retry lineage changed');
      markdown = readFileSync(
        join(this.options.stateDirectory, 'briefs', `${member.taskId}-${attempt.attempt}.md`),
        'utf8',
      );
      if (attempt.newBriefHash !== controlPlaneBriefHash(markdown)) throw new Error('Historical brief hash changed');
    }
    const brief = parseBrief(
      markdown,
      readRiskOwnership(this.options.riskAreasFile ?? join(import.meta.dir, '../risk-areas.json')),
    );
    const requested = store.events(member.taskId, member.attempt).find((event) => event.kind === 'landing-requested');
    const authorized = store
      .events(member.taskId, member.attempt)
      .findLast((event) => event.kind === 'manager-landing-authorized');
    const { managerLanding: _authorization, ...original } = entry.request;
    const settled = requested ? (JSON.parse(requested.body) as LandingRequest) : undefined;
    if (settled?.managerLanding) delete settled.managerLanding;
    if (settled?.workerCommit && !original.workerCommit && settled.workerCommit === member.acceptedCommit)
      delete settled.workerCommit;
    if (
      brief.manager !== previous.manifest.managerId ||
      brief.goal !== 'control-plane' ||
      !isDeepStrictEqual(brief.paths, entry.request.declaredPaths) ||
      !isDeepStrictEqual(brief.acceptance.command, entry.request.gate) ||
      !isDeepStrictEqual(settled, original) ||
      !authorized ||
      !isDeepStrictEqual(JSON.parse(authorized.body), entry.request.managerLanding)
    )
      throw new Error('Historical accepted request/brief/source lineage is not exact');
    return JSON.stringify({ request: entry.request, brief });
  }

  private assertControlPlaneRetryLineage(
    store: WorkerStore,
    prior: ControlPlaneBatchSource,
    current: ControlPlaneBatchSource,
    historicalIdentity: string,
  ): void {
    if (
      current.taskId !== prior.taskId ||
      current.attempt <= prior.attempt ||
      current.acceptedCommit === prior.acceptedCommit
    )
      throw new Error('Corrected generation must be a newer accepted source of the same task');
    let hash = controlPlaneBriefHash((JSON.parse(historicalIdentity) as { brief: Task['brief'] }).brief.markdown);
    for (let number = prior.attempt; number < current.attempt; number++) {
      const old = store.attempt({ taskId: prior.taskId, attempt: number });
      const next = store.attempt({ taskId: prior.taskId, attempt: number + 1 });
      if (
        old.state !== 'superseded' ||
        !old.supersededFinalized ||
        !store.events(prior.taskId, next.attempt).some((event) => event.kind === 'worker-run-started')
      )
        throw new Error('Corrected generation requires the actual public retry lineage');
      if (next.newBriefHash || next.previousBriefHash) {
        if (next.previousBriefHash !== hash || !next.newBriefHash)
          throw new Error('Corrected brief retry lineage changed');
        hash = next.newBriefHash;
      }
    }
    const task = store.task(current.taskId);
    const requested = store.events(current.taskId, current.attempt).find((event) => event.kind === 'landing-requested');
    const settled = requested ? (JSON.parse(requested.body) as LandingRequest) : undefined;
    if (
      hash !== controlPlaneBriefHash(task.brief.markdown) ||
      readFileSync(task.briefPath, 'utf8') !== task.brief.markdown ||
      settled?.workerCommit !== current.acceptedCommit ||
      settled.branch !== task.branch ||
      settled.worktree !== task.worktree
    )
      throw new Error('Corrected generation lacks its exact public brief/source settlement');
  }

  /** Owner receiving operation: no checks, refs, task transitions or outcome rewriting. */
  async supersedeControlPlaneBatch(
    input: ControlPlaneBatchSupersession,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ControlPlaneBatchSupersessionResult> {
    const o = this.options;
    if (!(o.fence instanceof WorkerStore) || o.queue.db !== o.fence.db)
      throw new Error('Supersession requires the native shared worker store');
    const store = o.fence;
    const manifest = parseControlPlaneBatchManifest(input.replacement);
    const actor = authenticatedManager(store.db, env);
    if (env.GOAL_TASK_ID || env.GOAL_ATTEMPT || !actor || actor.id !== manifest.managerId)
      throw new Error('Supersession requires an authenticated owning manager session');
    if (
      input.version !== 1 ||
      !/^[0-9a-f]{64}$/.test(input.previousBatchId) ||
      !input.handoff ||
      !/^[0-9a-f]{64}$/.test(input.handoff.journalHash) ||
      !input.handoff.evidence?.trim() ||
      !Array.isArray(input.handoff.ownedCommands) ||
      (input.handoff.inventory !== undefined &&
        !['complete', 'legacy-inventory-unavailable'].includes(input.handoff.inventory)) ||
      !Array.isArray(input.changedInputs) ||
      !input.changedInputs.length
    )
      throw new Error('Supersession requires exact verified terminal handoff and changed producer inputs');
    const batchId = controlPlaneBatchId(manifest);
    if (batchId === input.previousBatchId) throw new Error('Replacement cohort must genuinely change');
    const lease = acquireDirectoryLease(join(o.stateDirectory, 'train-main.lease'));
    try {
      const path = join(o.stateDirectory, `control-plane-batch-${input.previousBatchId}.json`);
      const writeClosure = (previous: ControlPlaneBatchJournal, result: ControlPlaneBatchSupersessionResult) => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ ...previous, superseded: result }, null, 2) + '\n', { mode: 0o600 });
        renameSync(temporary, path);
      };
      const saved = o.queue.controlPlaneSupersession(input.previousBatchId);
      if (saved) {
        const receipt = JSON.parse(saved) as {
          input: ControlPlaneBatchSupersession;
          previous: ControlPlaneBatchJournal;
          result: ControlPlaneBatchSupersessionResult;
        };
        if (!isDeepStrictEqual(receipt.input, input))
          throw new Error('Supersession already has a different immutable replacement');
        // The transaction is authoritative if a crash interrupted journal materialization.
        writeClosure(receipt.previous, receipt.result);
        return receipt.result;
      }
      const raw = readFileSync(path, 'utf8');
      const previous = JSON.parse(raw) as ControlPlaneBatchJournal;
      if (
        createHash('sha256').update(raw).digest('hex') !== input.handoff.journalHash ||
        previous.version !== 1 ||
        previous.batchId !== input.previousBatchId ||
        previous.superseded ||
        controlPlaneBatchId(previous.manifest) !== input.previousBatchId ||
        previous.manifest.managerId !== actor.id
      )
        throw new Error('Supersession journal identity, owner or generation changed');
      const dead = (identity: ProcessIdentity) => {
        if (
          !identity ||
          !Number.isSafeInteger(identity.pid) ||
          identity.pid < 1 ||
          !Number.isSafeInteger(identity.group) ||
          identity.group < 1 ||
          !/^\d+$/.test(identity.start) ||
          !identity.boot
        )
          throw new Error('Verified physical process incarnation is required');
        if (
          sameProcess(identity) ||
          groupMembers(identity.group).some(
            (member) => member.boot === identity.boot && BigInt(member.start) >= BigInt(identity.start),
          )
        )
          throw new Error('Prior controller or owned command is still active');
      };
      dead(input.handoff.controller);
      for (const command of input.handoff.ownedCommands) dead(command);
      if (previous.controller && !isDeepStrictEqual(previous.controller, input.handoff.controller))
        throw new Error('Terminal handoff names the wrong controller incarnation');
      // Unknown legacy children are not a physical cleanup receipt. Inspect only positively recorded identities.
      for (const member of previous.manifest.members) {
        for (const event of store
          .events(member.taskId, member.attempt)
          .filter((event) => event.kind === 'train-resolver-process')) {
          const identity = (JSON.parse(event.body) as { process?: ProcessIdentity }).process;
          if (identity) dead(identity);
        }
      }
      const failures: { candidate: string; indices: number[] }[] = [];
      for (const [key, node] of Object.entries(previous.nodes)) {
        if (
          (node.prepared && this.controlPlaneRecordPublished(node.prepared.record)) ||
          previous.results.some((result) => result.disposition !== 'excluded')
        )
          throw new Error('A published prior cohort cannot be superseded');
        for (const proof of node.proofs ?? [])
          if (!proof.result.passed && !proof.result.timedOut) {
            if (!proof.result.failedCommand?.length || !proof.result.output)
              throw new Error('Retained negative proof lacks its actual command or output');
            failures.push({
              candidate: proof.candidate,
              indices: proof.sources.map((source) =>
                previous.manifest.members.findIndex(
                  (member) =>
                    member.taskId === source.taskId &&
                    member.attempt === source.attempt &&
                    member.acceptedCommit === source.acceptedCommit,
                ),
              ),
            });
          }
        if (!node.proofs?.length && node.failure) {
          const supplied = input.handoff.failures?.find((failure) => failure.node === key);
          const log = readFileSync(node.logPath, 'utf8');
          if (
            !supplied ||
            !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(supplied.candidate) ||
            supplied.output !== node.failure ||
            !log.includes(supplied.output) ||
            !log.includes(`Control-plane checks on ${supplied.candidate},`) ||
            !CONTROL_PLANE_CHECKS.some((command) => isDeepStrictEqual(command, supplied.failedCommand)) ||
            !log.includes(`(${supplied.failedCommand.join(' ')}: failed in `)
          )
            throw new Error('Legacy supersession requires exact retained failed candidate, command and output');
          failures.push({ candidate: supplied.candidate, indices: node.nativeMembers ?? node.indices });
        }
      }
      if (!failures.length) throw new Error('Supersession requires a retained completed native failure');
      for (const failure of failures)
        for (const index of failure.indices) {
          const member = previous.manifest.members[index];
          if (!member || !isAncestor(o.mainCheckout, member.acceptedCommit, failure.candidate))
            throw new Error('Retained failure candidate does not contain its actual accepted sources');
        }
      const priorMembers = previous.manifest.members;
      const added = manifest.members.filter((member) => !priorMembers.some((prior) => prior.taskId === member.taskId));
      const sameSource = (left: ControlPlaneBatchSource, right: ControlPlaneBatchSource) =>
        left.taskId === right.taskId && left.attempt === right.attempt && left.acceptedCommit === right.acceptedCommit;
      const mappings =
        input.memberMapping ??
        priorMembers.map((previous) => ({ previous, disposition: 'replacement' as const, current: previous }));
      if (
        !Array.isArray(mappings) ||
        mappings.length !== priorMembers.length ||
        new Set(mappings.map((mapping) => mapping.previous?.taskId)).size !== priorMembers.length ||
        mappings.some(
          (mapping) =>
            !mapping.previous ||
            !priorMembers.some((prior) => sameSource(prior, mapping.previous)) ||
            (mapping.disposition === 'replacement'
              ? !mapping.current ||
                mapping.current.taskId !== mapping.previous.taskId ||
                !manifest.members.some((member) => sameSource(member, mapping.current))
              : mapping.disposition !== 'deferred-to-dev' ||
                !mapping.cause?.trim() ||
                manifest.members.some((member) => member.taskId === mapping.previous.taskId)),
        ) ||
        manifest.members.some((member) => member.readmitFrom)
      )
        throw new Error(
          'Replacement mapping must cover every exact prior identity once with the same task or an explicit dev deferral',
        );
      const deferred = mappings.filter((mapping) => mapping.disposition === 'deferred-to-dev');
      if (
        deferred.length &&
        (!input.deferralAuthorization?.order?.trim() ||
          !Number.isSafeInteger(input.deferralAuthorization.expectedDeferredCount) ||
          input.deferralAuthorization.expectedDeferredCount !== deferred.length)
      )
        throw new Error('Dev deferral requires the owning manager Root order and exact deferred count');
      if (
        !added.length &&
        !mappings.some(
          (mapping) => mapping.disposition === 'replacement' && !sameSource(mapping.previous, mapping.current),
        )
      )
        throw new Error('Replacement must include genuinely changed accepted producer sources');
      if (existsSync(join(o.stateDirectory, `control-plane-batch-${batchId}.json`)))
        throw new Error('Replacement must be a fresh unpublished cohort');
      const verify = () => {
        if (readFileSync(path, 'utf8') !== raw) throw new Error('Supersession journal changed under its fence');
        for (const mapping of mappings) {
          const prior = mapping.previous;
          const historicalIdentity = this.historicalControlPlaneIdentity(store, previous, prior);
          if (mapping.disposition === 'replacement') {
            if (!sameSource(prior, mapping.current))
              this.assertControlPlaneRetryLineage(store, prior, mapping.current, historicalIdentity);
          } else {
            // Deferral is restricted to members that never reached native validation, even in another node.
            const index = priorMembers.findIndex((member) => sameSource(member, prior));
            const result = previous.results.find((member) => sameSource(member, prior));
            const legacyPreparation =
              result?.phase === undefined &&
              result?.files?.length &&
              result.reason?.startsWith(`Source ${prior.acceptedCommit}: Error: Source merge conflicts:`);
            const native = Object.values(previous.nodes).some(
              (node) =>
                node.nativeMembers?.includes(index) ||
                node.proofs?.some((proof) => proof.sources.some((source) => sameSource(source, prior))) ||
                (node.failure && node.indices.includes(index)) ||
                node.prepared?.record.members?.some((member) => sameSource(member.disposition, prior)),
            );
            if (
              result?.disposition !== 'excluded' ||
              result.mergedCommit ||
              (result.phase !== 'preparation' && !legacyPreparation) ||
              native
            )
              throw new Error('Dev deferral requires an exact preparation exclusion without native evidence');
            assertControlPlaneMember(store, prior.taskId, actor.id);
            store.assertCurrent(prior);
            const task = store.task(prior.taskId);
            const entry = o.queue.entry(prior)!;
            if (
              task.state !== 'landing' ||
              (previous.identities &&
                previous.identities[prior.taskId] !==
                  JSON.stringify({
                    request: entry.request,
                    brief: task.brief,
                    base: task.base,
                    frozen: frozenFilesForTask(o.stateDirectory, task.id),
                  })) ||
              (!previous.identities && !isDeepStrictEqual(JSON.parse(historicalIdentity).brief, task.brief))
            )
              throw new Error('Deferred request/contract generation changed');
            if (!previous.identities)
              this.assertLegacyControlPlaneGeneration(store, entry.request, prior.acceptedCommit);
            assertManagerLandingEvidence(entry.request, store, {
              allowNoDeltaOn: git(o.mainCheckout, 'rev-parse', `refs/heads/${o.mainBranch ?? 'main'}^{commit}`),
            });
          }
        }
        for (const member of manifest.members) {
          assertControlPlaneMember(store, member.taskId, actor.id);
          store.assertCurrent(member);
          const task = store.task(member.taskId);
          const entry = o.queue.entry(member);
          const prior = priorMembers.find((item) => sameSource(item, member));
          if (
            !entry ||
            entry.outcome ||
            entry.delivered ||
            entry.candidate ||
            entry.batchId !== (prior ? input.previousBatchId : null) ||
            entry.request.managerLanding?.managerId !== actor.id ||
            entry.request.managerLanding.acceptedCommit !== member.acceptedCommit ||
            task.state !== 'landing' ||
            (entry.request.workerCommit && entry.request.workerCommit !== member.acceptedCommit)
          )
            throw new Error('Supersession source is processed, published, claimed elsewhere or changed');
          const published = this.readControlPlaneRecord(entry.request);
          if (published && this.controlPlaneRecordPublished(published))
            throw new Error('Prior published release record is immutable');
          for (const event of store
            .events(member.taskId, member.attempt)
            .filter((event) => event.kind === 'train-resolver-process')) {
            const resolverProcess = (JSON.parse(event.body) as { process?: ProcessIdentity }).process;
            if (resolverProcess) dead(resolverProcess);
          }
          if (prior) {
            const identity = JSON.stringify({
              request: entry.request,
              brief: task.brief,
              base: task.base,
              frozen: frozenFilesForTask(o.stateDirectory, task.id),
            });
            if (previous.identities) {
              if (previous.identities[task.id] !== identity)
                throw new Error('Supersession request/contract generation changed');
            } else this.assertLegacyControlPlaneGeneration(store, entry.request, member.acceptedCommit);
          }
          assertManagerLandingEvidence(entry.request, store, {
            allowNoDeltaOn: git(o.mainCheckout, 'rev-parse', `refs/heads/${o.mainBranch ?? 'main'}^{commit}`),
          });
        }
        for (const changed of input.changedInputs) {
          // Preparation-excluded old members can be the omitted producers: their source never reached
          // the failed candidate, even though the old manifest already named them.
          const member = manifest.members.find((item) => item.taskId === changed.taskId);
          if (
            !member ||
            !changed.reason?.trim() ||
            !/^tools\/goal\/[a-zA-Z0-9_./-]+$/.test(changed.path) ||
            changed.path.split('/').includes('..') ||
            !matchesPath(changed.path, store.task(member.taskId).brief.paths)
          )
            throw new Error(
              'Changed producer input must name an actual omitted or added owner source and relevance reason',
            );
          const fork = git(o.mainCheckout, 'merge-base', store.task(member.taskId).base, member.acceptedCommit);
          if (
            failures.some((failure) => isAncestor(o.mainCheckout, member.acceptedCommit, failure.candidate)) ||
            !changedPathsBetween(o.mainCheckout, fork, member.acceptedCommit).includes(changed.path) ||
            failures.some(
              (failure) =>
                spawnSync('git', ['diff', '--quiet', failure.candidate, member.acceptedCommit, '--', changed.path], {
                  cwd: o.mainCheckout,
                }).status !== 1,
            )
          )
            throw new Error('Replacement producer input is unchanged from a retained failed candidate');
        }
      };
      const failedIndices = new Set(failures.flatMap((failure) => failure.indices));
      const result: ControlPlaneBatchSupersessionResult = {
        previousBatchId: input.previousBatchId,
        replacementBatchId: batchId,
        status: 'superseded/interrupted',
        members: priorMembers.map((member, index) => ({
          taskId: member.taskId,
          attempt: member.attempt,
          acceptedCommit: member.acceptedCommit,
          disposition: failedIndices.has(index) ? 'failed' : 'unknown',
        })),
        physicalInventory: input.handoff.inventory ?? 'complete',
        ...(deferred.length
          ? {
              devHandoff: {
                previousBatchId: input.previousBatchId,
                replacementBatchId: batchId,
                ownerId: actor.id,
                authorization: input.deferralAuthorization!,
                members: deferred.map((mapping) => {
                  const member = mapping.previous;
                  const entry = o.queue.entry(member)!;
                  return {
                    ...member,
                    queueEntryId: entry.id,
                    claimBatchId: input.previousBatchId,
                    request: entry.request,
                    contractIdentity: this.historicalControlPlaneIdentity(store, previous, member),
                    cause: mapping.cause,
                  };
                }),
              },
            }
          : {}),
      };
      o.queue.claimControlPlaneBatch(
        batchId,
        manifest.members,
        priorMembers
          .filter((prior) => manifest.members.some((member) => sameSource(member, prior)))
          .map((member) => ({
            ...member,
            fromBatchId: input.previousBatchId,
            request: o.queue.entry(member)!.request,
          })),
        verify,
        {
          previousBatchId: input.previousBatchId,
          body: JSON.stringify({ input, previous, result, failures }),
          historicalClaims: priorMembers.map((member) => ({ ...member, request: o.queue.entry(member)!.request })),
        },
      );
      writeClosure(previous, result);
      return result;
    } finally {
      lease.release();
    }
  }

  /** Consume retained preparation deferrals only after the complete corrected main cohort was published. */
  async receiveControlPlaneBatchDevHandoff(
    input: ControlPlaneBatchDevHandoffRequest,
    receiveDev: (handoff: ControlPlaneBatchDevHandoff) => void,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ControlPlaneBatchDevHandoff> {
    const o = this.options;
    if (!(o.fence instanceof WorkerStore) || o.queue.db !== o.fence.db)
      throw new Error('Dev handoff requires the native shared worker store');
    const store = o.fence;
    const actor = authenticatedManager(store.db, env);
    if (env.GOAL_TASK_ID || env.GOAL_ATTEMPT || !actor)
      throw new Error('Dev handoff requires an authenticated owning manager session');
    const lease = acquireDirectoryLease(join(o.stateDirectory, 'train-main.lease'));
    try {
      const raw = o.queue.controlPlaneSupersession(input.previousBatchId);
      const receipt = raw
        ? (JSON.parse(raw) as {
            previous: ControlPlaneBatchJournal;
            input: ControlPlaneBatchSupersession;
            result: ControlPlaneBatchSupersessionResult;
          })
        : undefined;
      const handoff = receipt?.result.devHandoff;
      if (
        !receipt ||
        !handoff ||
        handoff.ownerId !== actor.id ||
        input.replacementBatchId !== handoff.replacementBatchId
      )
        throw new Error('No exact owning manager dev handoff exists for this replacement');
      const verify = () => {
        if (o.queue.controlPlaneSupersession(input.previousBatchId) !== raw)
          throw new Error('Dev handoff changed under its native fence');
        const journal = JSON.parse(
          readFileSync(join(o.stateDirectory, `control-plane-batch-${input.replacementBatchId}.json`), 'utf8'),
        ) as ControlPlaneBatchJournal;
        const root = journal.nodes.root;
        const record = root?.prepared?.record;
        if (
          journal.superseded ||
          !isDeepStrictEqual(journal.manifest, receipt.input.replacement) ||
          !record ||
          !this.controlPlaneRecordPublished(record) ||
          record.members?.length !== receipt.input.replacement.members.length ||
          !receipt.input.replacement.members.every((member) =>
            record.members?.some(
              (item) =>
                item.request.taskId === member.taskId &&
                item.request.attempt === member.attempt &&
                item.disposition.acceptedCommit === member.acceptedCommit,
            ),
          ) ||
          !root?.proofs?.some(
            (proof) => proof.candidate === record.mainCommit && proof.result.passed && !proof.result.negativeOnly,
          )
        )
          throw new Error('Dev handoff requires the complete corrected cohort published with fresh full native proof');
        for (const member of handoff.members) {
          assertControlPlaneMember(store, member.taskId, actor.id);
          store.assertCurrent(member);
          const task = store.task(member.taskId);
          const identity = this.historicalControlPlaneIdentity(store, receipt.previous, member);
          if (
            identity !== member.contractIdentity ||
            o.queue.entry(member)?.id !== member.queueEntryId ||
            (receipt.previous.identities &&
              identity !==
                JSON.stringify({
                  request: member.request,
                  brief: task.brief,
                  base: task.base,
                  frozen: frozenFilesForTask(o.stateDirectory, task.id),
                })) ||
            (!receipt.previous.identities && !isDeepStrictEqual(JSON.parse(identity).brief, task.brief))
          )
            throw new Error('Deferred current request/contract identity changed before migration');
          if (!receipt.previous.identities)
            this.assertLegacyControlPlaneGeneration(store, member.request, member.acceptedCommit);
          assertManagerLandingEvidence(member.request, store, {
            allowNoDeltaOn: git(o.mainCheckout, 'rev-parse', `refs/heads/${o.mainBranch ?? 'main'}^{commit}`),
          });
        }
      };
      o.queue.consumeControlPlaneDevHandoff(handoff, verify, receiveDev);
      return handoff;
    } finally {
      lease.release();
    }
  }

  /** Main -> dev is the only nested train order. Dev never takes main while holding its lane. */
  private async withControlPlaneBatchLanes<T>(run: () => Promise<T>): Promise<T> {
    const main = acquireDirectoryLease(join(this.options.stateDirectory, 'train-main.lease'));
    try {
      const dev = await acquireControlPlaneDevLane(this.options.stateDirectory);
      try {
        return await run();
      } finally {
        dev.release();
      }
    } finally {
      main.release();
    }
  }

  /** Authenticated, append-only receiving operation for the same exact ref-starved source generation. */
  async continueControlPlaneBatchRefs(
    value: ControlPlaneBatchRefContinuation,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ControlPlaneBatchResult> {
    const input = parseControlPlaneBatchRefContinuation(value);
    const manifest = input.manifest;
    const batchId = controlPlaneBatchId(manifest);
    const o = this.options;
    if (!(o.fence instanceof WorkerStore) || o.queue.db !== o.fence.db)
      throw new Error('Ref continuation requires the native shared worker store');
    const store = o.fence;
    const actor = authenticatedManager(store.db, env);
    if (env.GOAL_TASK_ID || env.GOAL_ATTEMPT || !actor || actor.id !== manifest.managerId)
      throw new Error('Ref continuation requires an authenticated owning manager session');
    return this.withControlPlaneBatchLanes(async () => {
      const path = join(o.stateDirectory, `control-plane-batch-${batchId}.json`);
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const saved = o.queue.controlPlaneRefContinuation(batchId);
      const raw = readFileSync(path, 'utf8');
      const journal = JSON.parse(raw) as ControlPlaneBatchJournal;
      const member = manifest.members[0]!;
      const identity = () => {
        const task = store.task(member.taskId);
        return JSON.stringify({
          request: o.queue.entry(member)?.request,
          brief: task.brief,
          base: task.base,
          frozen: frozenFilesForTask(o.stateDirectory, member.taskId),
        });
      };
      const assertSource = (recovery = false) => {
        if (!isDeepStrictEqual(authenticatedManager(store.db, env), actor))
          throw new Error('Ref continuation manager session changed while waiting');
        assertControlPlaneMember(store, member.taskId, manifest.managerId);
        store.assertCurrent(member);
        const task = store.task(member.taskId);
        const entry = o.queue.entry(member);
        if (
          !entry ||
          entry.batchId !== batchId ||
          journal.identities?.[member.taskId] !== identity() ||
          readFileSync(task.briefPath, 'utf8') !== task.brief.markdown ||
          entry.request.managerLanding?.managerId !== actor.id ||
          entry.request.managerLanding.acceptedCommit !== member.acceptedCommit ||
          (entry.request.workerCommit && entry.request.workerCommit !== member.acceptedCommit) ||
          git(o.mainCheckout, 'rev-parse', `refs/heads/${entry.request.branch}^{commit}`) !== member.acceptedCommit ||
          (!recovery &&
            (entry.outcome || entry.delivered || entry.candidate || task.integratedCommit || task.mergedCommit))
        )
          throw new Error('Ref continuation source, contract, request or claim changed or was processed');
        const claim = o.queue.db
          .query('SELECT request FROM landing_batch_claims WHERE batch=? AND task=? AND attempt=?')
          .get(batchId, member.taskId, member.attempt) as { request: string } | null;
        if (!claim || !isDeepStrictEqual(JSON.parse(claim.request), entry.request))
          throw new Error('Ref continuation requires the exact retained native claim');
        assertManagerLandingEvidence(entry.request, store, {
          allowIntegrated: recovery,
          allowNoDeltaOn: git(o.mainCheckout, 'rev-parse', `refs/heads/${o.mainBranch ?? 'main'}^{commit}`),
        });
        if (
          !isDeepStrictEqual(
            journal.scopeApprovals?.[member.taskId] ?? null,
            controlPlaneScopeApproval(member, {
              store,
              queue: o.queue,
              ...(o.mainBranch ? { mainBranch: o.mainBranch } : {}),
              ...(o.riskAreasFile ? { riskAreasFile: o.riskAreasFile } : {}),
            }) ?? null,
          )
        )
          throw new Error('Ref continuation native scope approval changed');
      };
      if (
        journal.version !== 1 ||
        journal.batchId !== batchId ||
        !isDeepStrictEqual(journal.manifest, manifest) ||
        journal.superseded ||
        o.queue.controlPlaneSupersession(batchId)
      )
        throw new Error('Ref continuation manifest or journal changed');
      if (saved) {
        const receipt = JSON.parse(saved) as ControlPlaneRefContinuationReceipt;
        const { id, ...body } = receipt;
        const previous = JSON.parse(receipt.previousJournal) as ControlPlaneBatchJournal;
        const node = journal.nodes[refContinuationNode];
        if (
          id !== digest(JSON.stringify(body)) ||
          !isDeepStrictEqual(receipt.input, input) ||
          digest(receipt.previousJournal) !== input.handoff.journalHash ||
          journal.refContinuation?.receiptId !== id ||
          !isDeepStrictEqual(journal.refContinuation.controller, receipt.controller) ||
          digest(readFileSync(previous.nodes.root!.logPath, 'utf8')) !== input.logHash ||
          Object.keys(journal.nodes).length !== 2 ||
          !isDeepStrictEqual(journal.controller, previous.controller) ||
          !isDeepStrictEqual(journal.nodes.root, previous.nodes.root) ||
          !isDeepStrictEqual(journal.identities, previous.identities) ||
          !isDeepStrictEqual(journal.scopeApprovals, previous.scopeApprovals)
        )
          throw new Error('Ref continuation already has different immutable authority or history');
        if (!node || node.attempts !== 1 || node.children)
          throw new Error('Ref continuation is already live, interrupted or spent; no second candidate is allowed');
        const proof = node.proofs?.[0];
        const published = node.prepared && this.controlPlaneRecordPublished(node.prepared.record);
        const exclusion =
          journal.results.length === 1 &&
          journal.results[0]!.disposition === 'excluded' &&
          !journal.results[0]!.mergedCommit &&
          isDeepStrictEqual(
            {
              taskId: journal.results[0]!.taskId,
              attempt: journal.results[0]!.attempt,
              acceptedCommit: journal.results[0]!.acceptedCommit,
            },
            member,
          );
        if (published) {
          if (
            node.proofs?.length !== 1 ||
            proof?.result.passed !== true ||
            proof.result.timedOut !== false ||
            proof.candidate !== node.prepared!.record.mainCommit ||
            !proof.result.lifecycleEvidence ||
            !proof.result.compatibilityCommand ||
            proof.result.lifecycleEvidence !== node.prepared!.record.lifecycleEvidence ||
            !isDeepStrictEqual(proof.result.compatibilityCommand, node.prepared!.record.compatibilityCommand) ||
            !isDeepStrictEqual(proof.snapshot, node.prepared!.snapshot) ||
            !isDeepStrictEqual(proof.sources, manifest.members)
          )
            throw new Error('Ref continuation published proof identity changed');
        } else if (
          !exclusion ||
          node.prepared ||
          !(
            (node.failure &&
              node.proofs?.length === 1 &&
              proof?.result.passed === false &&
              node.failure === proof.result.output) ||
            (node.completed && !node.proofs?.length)
          )
        ) {
          throw new Error('Ref continuation is already live, interrupted or spent; no second candidate is allowed');
        }
        assertSource(true);
        return this.executeControlPlaneBatch(manifest, env, receipt);
      }
      const root = journal.nodes.root;
      if (
        digest(raw) !== input.handoff.journalHash ||
        journal.refContinuation ||
        Object.keys(journal.nodes).length !== 1 ||
        !root ||
        root.attempts !== 3 ||
        !isDeepStrictEqual(root.indices, [0]) ||
        !isDeepStrictEqual(root.nativeMembers, [0]) ||
        root.children ||
        root.failure ||
        root.prepared ||
        root.completed ||
        root.negativeProbes?.length ||
        journal.results.length ||
        root.proofs?.length !== 3 ||
        !journal.controller ||
        !isDeepStrictEqual(journal.controller, input.handoff.controller)
      )
        throw new Error('Ref continuation requires an exact unpublished three-attempt ref-only exhaustion');
      const dead = (identity: ProcessIdentity) => {
        if (
          !identity ||
          !Number.isSafeInteger(identity.pid) ||
          identity.pid < 1 ||
          !Number.isSafeInteger(identity.group) ||
          identity.group < 1 ||
          !/^\d+$/.test(identity.start) ||
          !identity.boot
        )
          throw new Error('Ref continuation requires verified physical process incarnations');
        if (
          sameProcess(identity) ||
          groupMembers(identity.group).some(
            (member) => member.boot === identity.boot && BigInt(member.start) >= BigInt(identity.start),
          )
        )
          throw new Error('Prior controller or positively recorded owned operation is still active');
      };
      dead(input.handoff.controller);
      for (const command of input.handoff.ownedCommands) dead(command);
      for (const event of store
        .events(member.taskId, member.attempt)
        .filter((event) => event.kind === 'train-resolver-process')) {
        const process = (JSON.parse(event.body) as { process?: ProcessIdentity }).process;
        if (process) dead(process);
      }
      const logPath = join(o.stateDirectory, `control-plane-batch-${batchId}-root.log`);
      if (root.logPath !== logPath) throw new Error('Ref continuation root log path changed');
      const log = readFileSync(logPath, 'utf8');
      const segments = log.split(/\nCohort root attempt [1-3]\n/);
      if (digest(log) !== input.logHash || segments.length !== 4)
        throw new Error('Ref continuation requires the exact retained three-attempt log');
      for (const [offset, proof] of root.proofs.entries()) {
        const section = segments[offset + 1]!;
        if (
          proof.result.passed !== true ||
          proof.result.timedOut !== false ||
          proof.result.failedCommand ||
          proof.result.negativeOnly ||
          !proof.completedAt ||
          !isDeepStrictEqual(proof.sources, manifest.members) ||
          !isDeepStrictEqual(
            proof.scopeApprovals ?? {},
            Object.fromEntries(
              manifest.members.map((source) => [source.taskId, journal.scopeApprovals?.[source.taskId]?.id ?? null]),
            ),
          ) ||
          proof.snapshot.mainBranch !== (o.mainBranch ?? 'main') ||
          proof.snapshot.devBranch !== (o.integrationBranch ?? 'dev') ||
          !section.includes(`Control-plane checks on ${proof.candidate}, main ${proof.snapshot.mainHead}\n`) ||
          !section.includes('Captured refs moved; rebuilding bounded cohort\n') ||
          CONTROL_PLANE_CHECKS.some((command) => !section.includes(`(${command.join(' ')}: passed in `)) ||
          /: failed in /.test(section) ||
          git(o.mainCheckout, 'rev-parse', `refs/goal/control-plane-proof/${batchId}/root/${offset + 1}`) !==
            proof.candidate
        )
          throw new Error('Ref continuation refuses failed, unknown, timed-out or incomplete retained source proof');
      }
      assertSource();
      if (existsSync(this.controlPlaneRecordPath(o.queue.entry(member)!.request)))
        throw new Error('Ref continuation refuses any existing release/prepared record');
      const controller = processIdentity();
      if (!controller) throw new Error('Cannot identify the native continuation controller');
      const body = {
        input,
        actor: { managerId: actor.id, sessionId: actor.sessionId },
        previousJournal: raw,
        previousController: journal.controller,
        controller,
        receivedAt: new Date().toISOString(),
      };
      const receipt: ControlPlaneRefContinuationReceipt = { id: digest(JSON.stringify(body)), ...body };
      // No changes to prior proofs, logs, controller, attempt counts, claims or source results.
      store.write(member, () => {
        assertSource();
        o.queue.recordControlPlaneRefContinuation(batchId, JSON.stringify(receipt));
      });
      journal.refContinuation = { receiptId: receipt.id, controller };
      journal.nodes[refContinuationNode] = {
        indices: [0],
        attempts: 0,
        logPath: join(o.stateDirectory, `control-plane-batch-${batchId}-${refContinuationNode}.log`),
      };
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
      return this.executeControlPlaneBatch(manifest, env, receipt);
    });
  }

  /** Explicit main cohort release; holds both ordinary lanes through capture, proof, propagation and CAS. */
  async releaseControlPlaneBatch(
    input: ControlPlaneBatchManifest,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ControlPlaneBatchResult> {
    return this.withControlPlaneBatchLanes(() => this.executeControlPlaneBatch(input, env));
  }

  private async executeControlPlaneBatch(
    input: ControlPlaneBatchManifest,
    env: NodeJS.ProcessEnv,
    continuation?: ControlPlaneRefContinuationReceipt,
  ): Promise<ControlPlaneBatchResult> {
    const manifest = parseControlPlaneBatchManifest(input);
    const batchId = controlPlaneBatchId(manifest);
    const o = this.options;
    if (!(o.fence instanceof WorkerStore) || o.queue.db !== o.fence.db)
      throw new Error('Control-plane batches require the shared worker store and landing queue');
    const store = o.fence;
    const readmitted = manifest.members.filter((member) => member.readmitFrom);
    if (readmitted.length) {
      const actor = authenticatedManager(store.db, env);
      if (env.GOAL_TASK_ID || env.GOAL_ATTEMPT || !actor || actor.id !== manifest.managerId)
        throw new Error('Readmission requires an authenticated owning manager session');
    }
    const resolver = o.trainResolver ?? new TrainResolver(store);
    mkdirSync(o.stateDirectory, { recursive: true });
    {
      if (o.queue.controlPlaneRefContinuation(batchId) && !continuation)
        throw new Error('Ref-exhausted cohort requires its exact authenticated continuation receiver');
      if (o.queue.controlPlaneSupersession(batchId)) throw new Error('This cohort was superseded/interrupted');
      const replacement = o.queue.controlPlaneReplacement(batchId);
      const replacementInputs = replacement
        ? (JSON.parse(replacement) as {
            input: ControlPlaneBatchSupersession;
            previous: ControlPlaneBatchJournal;
            failures: { candidate: string; indices: number[] }[];
          })
        : undefined;
      const path = join(o.stateDirectory, `control-plane-batch-${batchId}.json`);
      let journal: ControlPlaneBatchJournal;
      if (existsSync(path)) {
        journal = JSON.parse(readFileSync(path, 'utf8')) as ControlPlaneBatchJournal;
        if (
          journal.version !== 1 ||
          journal.batchId !== batchId ||
          JSON.stringify(journal.manifest) !== JSON.stringify(manifest)
        )
          throw new Error('Control-plane batch journal does not match its immutable manifest');
      } else {
        journal = {
          version: 1,
          batchId,
          manifest,
          nodes: {
            root: {
              indices: manifest.members.map((_, index) => index),
              attempts: 0,
              logPath: join(o.stateDirectory, `control-plane-batch-${batchId}-root.log`),
            },
          },
          results: [],
        };
      }
      const save = () => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, path);
      };
      const identity = (taskId: string) => {
        const task = store.task(taskId);
        return JSON.stringify({
          request: o.queue.entry({ taskId, attempt: task.currentAttempt })?.request,
          brief: task.brief,
          base: task.base,
          frozen: frozenFilesForTask(o.stateDirectory, taskId),
        });
      };
      if (journal.superseded) throw new Error('This cohort was superseded/interrupted');
      // Save original generations, including preparation exclusions, before any model or native work.
      journal.identities ??= Object.fromEntries(
        manifest.members.map((member) => [member.taskId, identity(member.taskId)]),
      );
      const scopeRuntime = { store, queue: o.queue, ...(o.riskAreasFile ? { riskAreasFile: o.riskAreasFile } : {}) };
      if (!journal.scopeApprovals) {
        const approvals = Object.fromEntries(
          manifest.members.map((member) => [member.taskId, controlPlaneScopeApproval(member, scopeRuntime) ?? null]),
        );
        if (
          Object.values(approvals).some(Boolean) &&
          Object.values(journal.nodes).some(
            (node) => node.proofs?.length || node.prepared || node.nativeMembers?.length,
          )
        )
          throw new Error('New scope approval requires a fresh cohort, never an inherited native proof');
        journal.scopeApprovals = approvals;
      }
      const scopeEvidence = (indices: readonly number[]) =>
        Object.fromEntries(
          indices.map((index) => {
            const taskId = manifest.members[index]!.taskId;
            return [taskId, journal.scopeApprovals![taskId]?.id ?? null];
          }),
        );
      const transfers = readmitted
        .filter((member) => o.queue.entry(member)?.batchId !== batchId)
        .map((member) => {
          const entry = o.queue.entry(member);
          if (!entry) throw new Error(`Missing exact readmission request for ${member.taskId}`);
          return { ...member, fromBatchId: member.readmitFrom!, request: entry.request };
        });
      for (const member of readmitted) {
        const entry = o.queue.entry(member);
        if (entry?.batchId !== batchId) continue;
        const claim = o.queue.db
          .query('SELECT previous_batch, request FROM landing_batch_claims WHERE batch=? AND task=? AND attempt=?')
          .get(batchId, member.taskId, member.attempt) as { previous_batch: string | null; request: string } | null;
        if (
          !claim ||
          claim.previous_batch !== member.readmitFrom ||
          !isDeepStrictEqual(JSON.parse(claim.request), entry.request)
        )
          throw new Error('Readmission recovery has no exact durable transfer claim');
      }
      const verifyReadmissions = () => {
        for (const member of readmitted) {
          const previousPath = join(o.stateDirectory, `control-plane-batch-${member.readmitFrom}.json`);
          const previous = JSON.parse(readFileSync(previousPath, 'utf8')) as ControlPlaneBatchJournal;
          if (
            previous.version !== 1 ||
            previous.batchId !== member.readmitFrom ||
            controlPlaneBatchId(previous.manifest) !== member.readmitFrom ||
            previous.manifest.managerId !== manifest.managerId
          )
            throw new Error('Readmission journal owner or identity changed');
          const terminal = (key: string): boolean => {
            const node = previous.nodes[key];
            return (
              !!node &&
              (node.children
                ? node.children.every(terminal)
                : !!node.completed || (!!node.failure && node.indices.length === 1))
            );
          };
          if (
            !terminal('root') ||
            previous.results.length !== previous.manifest.members.length ||
            previous.manifest.members.some(
              (item) =>
                previous.results.filter(
                  (result) =>
                    result.taskId === item.taskId &&
                    result.attempt === item.attempt &&
                    result.acceptedCommit === item.acceptedCommit,
                ).length !== 1,
            )
          )
            throw new Error('Readmission requires a terminal prior cohort journal');
          const index = previous.manifest.members.findIndex(
            (item) =>
              item.taskId === member.taskId &&
              item.attempt === member.attempt &&
              item.acceptedCommit === member.acceptedCommit,
          );
          const result = previous.results.find((item) => item.taskId === member.taskId);
          // Legacy journals removed preparation conflicts from node.indices before starting native proof.
          // Any ancestor's native participation disqualifies a member, even if a later child excludes it.
          const hadNativeEvidence = Object.values(previous.nodes).some((node) =>
            (node.nativeMembers ?? node.indices).includes(index),
          );
          const legacyConflict =
            result?.phase === undefined &&
            result?.files?.length &&
            result.reason?.startsWith(`Source ${member.acceptedCommit}: Error: Source merge conflicts:`);
          if (
            index < 0 ||
            result?.disposition !== 'excluded' ||
            result.mergedCommit ||
            (result.phase !== 'preparation' && !legacyConflict) ||
            hadNativeEvidence
          )
            throw new Error('Readmission requires an exact preparation-only exclusion without native evidence');
          assertControlPlaneMember(store, member.taskId, manifest.managerId);
          store.assertCurrent(member);
          const entry = o.queue.entry(member);
          if (
            !entry ||
            (entry.batchId !== member.readmitFrom && entry.batchId !== batchId) ||
            entry.outcome ||
            entry.delivered ||
            entry.candidate ||
            entry.request.managerLanding?.managerId !== manifest.managerId ||
            entry.request.managerLanding.acceptedCommit !== member.acceptedCommit
          )
            throw new Error('Readmission source/request is no longer unprocessed and exact');
          if (previous.identities) {
            if (previous.identities[member.taskId] !== identity(member.taskId))
              throw new Error('Readmission contract/request generation changed');
          } else {
            this.assertLegacyControlPlaneGeneration(store, entry.request, member.acceptedCommit);
          }
          assertManagerLandingEvidence(entry.request, store, {
            allowNoDeltaOn: git(o.mainCheckout, 'rev-parse', `refs/heads/${o.mainBranch ?? 'main'}^{commit}`),
          });
        }
      };
      // The main lane excludes every live old controller. The shared SQLite fence covers the entire transfer.
      save();
      o.queue.claimControlPlaneBatch(batchId, manifest.members, transfers, verifyReadmissions);
      const controller = processIdentity();
      if (!controller) throw new Error('Cannot identify the native cohort controller incarnation');
      if (!continuation) journal.controller = controller;
      save();
      const disposition = (value: ControlPlaneBatchDisposition) => {
        journal.results = journal.results.filter((member) => member.taskId !== value.taskId);
        journal.results.push(value);
      };
      const assertMember = (index: number, recovery = false): LandingEntry => {
        const member = manifest.members[index]!;
        assertControlPlaneMember(store, member.taskId, manifest.managerId);
        store.assertCurrent(member);
        const entry = o.queue.entry(member);
        if (journal.identities?.[member.taskId] !== identity(member.taskId))
          throw new Error(`Batch member generation changed for ${member.taskId}`);
        if (
          !isDeepStrictEqual(
            journal.scopeApprovals![member.taskId],
            controlPlaneScopeApproval(member, scopeRuntime) ?? null,
          )
        )
          throw new Error(`Batch member native scope approval changed for ${member.taskId}`);
        if (
          !entry ||
          entry.batchId !== batchId ||
          !entry.request.managerLanding ||
          entry.request.managerLanding.managerId !== manifest.managerId ||
          entry.request.managerLanding.acceptedCommit !== member.acceptedCommit ||
          (entry.request.workerCommit && entry.request.workerCommit !== member.acceptedCommit)
        )
          throw new Error(`Batch source/request identity changed for ${member.taskId}`);
        assertManagerLandingEvidence(entry.request, store, {
          allowIntegrated: recovery,
          allowNoDeltaOn: git(o.mainCheckout, 'rev-parse', `refs/heads/${o.mainBranch ?? 'main'}^{commit}`),
        });
        // Even recovery must never attribute an old release to a newer source on the same attempt.
        if (git(o.mainCheckout, 'rev-parse', `refs/heads/${entry.request.branch}^{commit}`) !== member.acceptedCommit)
          throw new Error(`Accepted source moved for ${member.taskId}`);
        if (!recovery && (entry.outcome || entry.delivered))
          throw new Error(`Landing outcome for ${member.taskId} is already immutable`);
        return entry;
      };
      const cleanup = (record: ControlPlaneReleaseRecord, logPath: string) => {
        try {
          this.syncMainCheckout(record.mainBranch, [record.mainExpected, record.mainCommit]);
        } catch (error) {
          // Ref publication and its proof are durable. A checkout cleanup failure cannot turn green into red.
          appendFileSync(
            logPath,
            `Published release ${record.mainCommit}; checkout synchronization deferred: ${error}\n`,
          );
        }
      };
      const complete = (record: ControlPlaneReleaseRecord, node: ControlPlaneBatchNode) => {
        if (record.batchId !== batchId || !record.members?.length || !this.controlPlaneRecordPublished(record))
          throw new Error('Cannot recover batch without its exact verified published release record');
        const members = record.members;
        if (record.scopeApprovals && !isDeepStrictEqual(record.scopeApprovals, scopeEvidence(node.indices)))
          throw new Error('Published batch scope approval evidence changed');
        for (const index of node.indices) assertMember(index, true);
        for (const member of members) {
          if (JSON.stringify(o.queue.entry(member.request)?.request) !== JSON.stringify(member.request))
            throw new Error(`Published batch request identity changed for ${member.request.taskId}`);
        }
        store.commitBatchMerge(
          members.map((member) => ({ ...member.request, commit: record.mainCommit })),
          () => {
            for (const index of node.indices) assertMember(index, true);
            for (const member of members) {
              const entry = o.queue.entry(member.request)!;
              if (entry.outcome && JSON.stringify(entry.outcome) !== JSON.stringify(member.outcome))
                throw new Error(`Immutable landing outcome differs for ${member.request.taskId}`);
              if (!entry.outcome) o.queue.finish(entry.id, member.outcome);
            }
            return record.mainCommit;
          },
        );
        cleanup(record, node.logPath);
        for (const member of members) {
          disposition(member.disposition);
          const resolution = store
            .events(member.request.taskId, member.request.attempt)
            .filter((event) => event.kind === 'train-resolution')
            .map((event) => JSON.parse(event.body) as TrainConflict)
            .findLast(
              (conflict) =>
                conflict.sourceCommit === member.disposition.acceptedCommit &&
                !!conflict.resolvedCommit &&
                isAncestor(o.mainCheckout, conflict.resolvedCommit, record.mainCommit),
            );
          if (resolution) resolver.landed(member.request, resolution, record.mainCommit);
          const entry = o.queue.entry(member.request)!;
          if (!entry.delivered) {
            o.sink.onGateOutcome(member.outcome);
            o.queue.acknowledge(entry.id);
          }
          this.notifyOwnersOfOutsideChanges(
            member.request,
            outsideScope(member.outcome.changedFiles, member.request.declaredPaths),
            record.mainCommit,
            record.mainBranch,
            node.logPath,
          );
        }
        node.completed = true;
        save();
      };
      const visit = async (key: string): Promise<void> => {
        const node = journal.nodes[key]!;
        if (node.children) {
          for (const child of node.children) await visit(child);
          return;
        }
        if (node.prepared && this.controlPlaneRecordPublished(node.prepared.record)) {
          complete(node.prepared.record, node);
          return;
        }
        if (node.completed || node.failure) return;
        // Split decisions survive restart. A failed whole cohort is never silently retried or sent to serial drain.
        const split = (reason: string) => {
          node.failure = reason;
          appendFileSync(node.logPath, `\nCohort failed; bisecting ${node.indices.length} source(s): ${reason}\n`);
          if (node.indices.length === 1) {
            const member = manifest.members[node.indices[0]!]!;
            disposition({
              ...member,
              disposition: 'excluded',
              logPath: node.logPath,
              phase: 'native',
              reason: `Owning manager must fix this source; native proof failed: ${reason}`,
            });
          } else {
            const middle = Math.ceil(node.indices.length / 2);
            node.children = [`${key}-left`, `${key}-right`];
            for (const [offset, indices] of [node.indices.slice(0, middle), node.indices.slice(middle)].entries()) {
              const child = node.children[offset]!;
              const failed = node.proofs?.findLast((proof) => !proof.result.passed && !proof.result.timedOut);
              const files =
                failed?.result.failedCommand &&
                JSON.stringify(failed.result.failedCommand) === JSON.stringify(CONTROL_PLANE_CHECKS[3])
                  ? failingTestFiles(failed.result.output)
                      .filter(
                        (file) =>
                          /^tools\/goal\/src\/[a-zA-Z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
                          !file.split('/').includes('..'),
                      )
                      .slice(0, 3)
                  : [];
              journal.nodes[child] = {
                indices,
                attempts: 0,
                ...(files.length
                  ? { negativeProbes: [['bun', 'test', '--timeout', '30000', ...files]] }
                  : failed?.result.negativeOnly
                    ? { negativeProbes: node.negativeProbes }
                    : {}),
                logPath: join(o.stateDirectory, `control-plane-batch-${batchId}-${child}.log`),
              };
            }
          }
          save();
        };
        const retainedFailure = node.proofs?.findLast((proof) => !proof.result.passed);
        if (retainedFailure) {
          split(retainedFailure.result.output);
          for (const child of node.children ?? []) await visit(child);
          return;
        }
        for (;;) {
          if (node.attempts >= (continuation ? 1 : 3))
            throw new Error(
              continuation
                ? 'Control-plane ref continuation exhausted its single candidate/ref attempt'
                : `Control-plane batch ${key} exhausted three candidate/ref attempts`,
            );
          node.attempts++;
          save();
          appendFileSync(node.logPath, `\nCohort ${key} attempt ${node.attempts}\n`);
          const started = Date.now();
          const entries: LandingEntry[] = [];
          const eligible: number[] = [];
          for (const index of node.indices) {
            const member = manifest.members[index]!;
            try {
              entries.push(assertMember(index));
              eligible.push(index);
            } catch (error) {
              const reason = `Source ${member.acceptedCommit}: ${error}; owning manager must repair or resubmit`;
              appendFileSync(node.logPath, `${member.taskId}: ${reason}\n`);
              disposition({ ...member, disposition: 'excluded', phase: 'preparation', logPath: node.logPath, reason });
            }
          }
          if (eligible.length !== node.indices.length) {
            node.indices = eligible;
            save();
          }
          if (!entries.length) {
            node.completed = true;
            save();
            return;
          }
          const identities = new Map(
            node.indices.map((index) => {
              const member = manifest.members[index]!;
              const task = store.task(member.taskId);
              return [
                index,
                JSON.stringify({
                  request: o.queue.entry(member)!.request,
                  brief: task.brief,
                  base: task.base,
                  frozen: frozenFilesForTask(o.stateDirectory, member.taskId),
                }),
              ];
            }),
          );
          const assertIdentities = () => {
            for (const index of node.indices) {
              const entry = assertMember(index);
              const task = store.task(entry.request.taskId);
              if (
                identities.get(index) !==
                JSON.stringify({
                  request: entry.request,
                  brief: task.brief,
                  base: task.base,
                  frozen: frozenFilesForTask(o.stateDirectory, task.id),
                })
              )
                throw new Error(`Batch member generation changed for ${task.id}`);
            }
          };
          const snapshot = this.controlPlaneSnapshot(o.mainBranch ?? 'main');
          if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${snapshot.mainBranch}`)
            throw new Error('The main checkout must already have main checked out');
          const tree = resolve(o.worktreeRoot, `control-plane-batch-${randomUUID()}`);
          mkdirSync(o.worktreeRoot, { recursive: true });
          git(o.mainCheckout, 'worktree', 'add', '--detach', tree, snapshot.mainHead);
          try {
            const preparedMembers: NonNullable<ControlPlaneReleaseRecord['members']> = [];
            const contributionBases = new Map<string, string>();
            const resolutions: { request: LandingRequest; conflict: TrainConflict }[] = [];
            const cohortFrozen = node.indices.flatMap((index) =>
              frozenFilesForTask(o.stateDirectory, manifest.members[index]!.taskId),
            );
            let excluded = false;
            for (const [offset, entry] of entries.entries()) {
              const index = node.indices[offset]!;
              const member = manifest.members[index]!;
              const task = store.task(member.taskId);
              const tip = member.acceptedCommit;
              const fork = git(tree, 'merge-base', snapshot.mainHead, tip);
              const sourcePaths = changedPathsBetween(tree, fork === tip ? task.base : fork, tip);
              const frozen = frozenFilesForTask(o.stateDirectory, task.id);
              const before = git(tree, 'rev-parse', 'HEAD');
              const risk = readRiskOwnership(o.riskAreasFile ?? join(import.meta.dir, '../risk-areas.json'));
              const guardedRequest = {
                ...entry.request,
                declaredPaths: [
                  ...entry.request.declaredPaths,
                  ...(journal.scopeApprovals![task.id]?.additionalPaths.map((addition) => addition.path) ?? []),
                ],
                protectedPaths: [
                  ...(entry.request.protectedPaths ?? []),
                  ...Object.entries(risk.areas)
                    .filter(([area]) => !task.brief.riskAreas.includes(area))
                    .flatMap(([, paths]) => paths),
                ],
              };
              let files: string[] = [];
              let resolution: TrainConflict | undefined;
              try {
                if (sourcePaths.some((path) => !path.startsWith(CONTROL_PLANE_PATH)))
                  throw new Error(`Source is outside tools/goal: ${sourcePaths.join(', ')}`);
                this.checkControlPlaneScope(sourcePaths, guardedRequest, node.logPath);
                git(tree, 'reset', '--hard', tip);
                files = changedFrozenFiles(tree, frozen);
                if (files.length) throw new Error(`Frozen acceptance files changed: ${files.join(', ')}`);
                git(tree, 'reset', '--hard', before);
                if (!isAncestor(tree, tip, before)) {
                  const conflict = await resolver.compose(
                    guardedRequest,
                    tree,
                    before,
                    `refs/heads/${snapshot.mainBranch}`,
                    tip,
                    cohortFrozen.map((file) => file.path),
                    node.logPath,
                  );
                  if (conflict) {
                    files = conflict.conflictFiles;
                    if (!conflict.resolvedCommit)
                      throw new Error(
                        `Source merge conflicts: ${files.join(', ')}; ${conflict.detail ?? 'unresolved'}`,
                      );
                    resolution = conflict;
                  }
                }
                let after = git(tree, 'rev-parse', 'HEAD');
                if (after !== before && treeDiffIsEmpty(tree, before, after)) {
                  // A patch already represented on main needs a disposition, not an empty implementation merge.
                  git(tree, 'reset', '--hard', before);
                  after = before;
                }
                files = changedFrozenFiles(tree, frozen);
                if (files.length)
                  throw new Error(`Combined source changed frozen acceptance files: ${files.join(', ')}`);
                for (const earlier of preparedMembers) {
                  const erased = pathsChangedByTaskButUnchangedOnDev(
                    tree,
                    contributionBases.get(earlier.request.taskId)!,
                    after,
                    earlier.disposition.acceptedCommit,
                    earlier.outcome.changedFiles,
                  );
                  if (erased.length) {
                    files = erased;
                    throw new Error(
                      `Would erase accepted contribution ${earlier.disposition.acceptedCommit}: ${erased.join(', ')}`,
                    );
                  }
                }
                const changed = changedPathsBetween(tree, before, after);
                this.checkControlPlaneScope(changed, guardedRequest, node.logPath);
                const nonGenerated = nonGeneratedFiles(tree, changed);
                contributionBases.set(task.id, before);
                preparedMembers.push({
                  entryId: entry.id,
                  request: entry.request,
                  outcome: {
                    taskId: task.id,
                    attempt: member.attempt,
                    passed: true,
                    stage: 'merge',
                    logPath: node.logPath,
                    hostMs: 0,
                    changedFiles: changed,
                    diffLines: diffLineCount(tree, before),
                    nonGeneratedChangedFiles: nonGenerated,
                    nonGeneratedDiffLines: diffLineCount(tree, before, nonGenerated),
                  },
                  disposition: {
                    ...member,
                    disposition: treeDiffIsEmpty(tree, before, after) ? 'already-represented' : 'released',
                    logPath: node.logPath,
                  },
                });
                if (resolution) resolutions.push({ request: guardedRequest, conflict: resolution });
              } catch (error) {
                if (error instanceof TrainResolverInfrastructureError) throw error;
                try {
                  git(tree, 'merge', '--abort');
                } catch {
                  /* No open merge for source/scope refusals. */
                }
                git(tree, 'reset', '--hard', before);
                const reason = `Source ${tip}: ${error}; owning manager must fix files [${files.join(', ')}]`;
                appendFileSync(node.logPath, `${task.id}: ${reason}\n`);
                disposition({
                  ...member,
                  disposition: 'excluded',
                  phase: 'preparation',
                  logPath: node.logPath,
                  reason,
                  files,
                });
                excluded = true;
              }
            }
            if (excluded) {
              node.indices = node.indices.filter((index) =>
                preparedMembers.some((member) => member.request.taskId === manifest.members[index]!.taskId),
              );
              save();
            }
            if (!preparedMembers.length) {
              node.completed = true;
              save();
              return;
            }
            const frozen = node.indices.flatMap((index) =>
              frozenFilesForTask(o.stateDirectory, manifest.members[index]!.taskId),
            );
            const changed = changedPathsBetween(tree, snapshot.mainHead, git(tree, 'rev-parse', 'HEAD'));
            this.formatControlPlaneCandidate(tree, changed, node.logPath);
            const allowed = preparedMembers.flatMap((member) => [
              ...member.request.declaredPaths,
              ...(journal.scopeApprovals![member.request.taskId]?.additionalPaths.map((addition) => addition.path) ??
                []),
            ]);
            const outside = outsideScope(
              changedPathsBetween(tree, snapshot.mainHead, git(tree, 'rev-parse', 'HEAD')),
              allowed,
            );
            if (outside.length) throw new Error(`Combined candidate changed unapproved files: ${outside.join(', ')}`);
            const frozenChanges = changedFrozenFiles(tree, frozen);
            if (frozenChanges.length)
              throw new Error(`Combined candidate changed frozen acceptance files: ${frozenChanges.join(', ')}`);
            let candidate = git(tree, 'rev-parse', 'HEAD');
            if (replacementInputs) {
              const formerlyFailed = replacementInputs.failures.flatMap((failure) =>
                failure.indices.map((index) => replacementInputs.previous.manifest.members[index]!.taskId),
              );
              const needsProducer = node.indices.some((index) =>
                formerlyFailed.includes(manifest.members[index]!.taskId),
              );
              const missingProducer =
                needsProducer &&
                replacementInputs.failures.some(
                  (failure) =>
                    treeDiffIsEmpty(tree, failure.candidate, candidate) ||
                    replacementInputs.input.changedInputs.some(
                      (input) =>
                        spawnSync('git', ['diff', '--quiet', failure.candidate, candidate, '--', input.path], {
                          cwd: tree,
                        }).status !== 1,
                    ),
                );
              if (missingProducer) {
                const reason =
                  'Replacement composition omitted its changed producer inputs; retained native failure remains failed';
                if (key === 'root') throw new Error(reason);
                // A split that removed the required producer cannot retest the unchanged failed source.
                // This is an inherited negative, never new native proof or an inferred pass.
                split(reason);
                break;
              }
            }
            node.nativeMembers = [...new Set([...(node.nativeMembers ?? []), ...node.indices])];
            save();
            // Formatting is controller-owned; each affected member still carries its original source and contribution.
            for (const member of preparedMembers) {
              member.outcome.mergedCommit = candidate;
              member.disposition.mergedCommit = candidate;
            }
            const proof = await this.verifyControlPlaneCandidate(
              tree,
              candidate,
              snapshot,
              node.logPath,
              async (output) => {
                // Only actual TypeScript diagnostics in a resolved file can spend the single repair budget.
                const resolved = resolutions.findLast(
                  (item) =>
                    /error TS\d+/.test(output) && item.conflict.conflictFiles.some((file) => output.includes(file)),
                );
                if (
                  !resolved ||
                  !(await resolver.repair(resolved.request, tree, resolved.conflict, output, node.logPath))
                )
                  return;
                const repaired = git(tree, 'rev-parse', 'HEAD');
                if (repaired === candidate) return;
                const frozenChanges = changedFrozenFiles(tree, cohortFrozen);
                if (frozenChanges.length)
                  throw new Error(`Typing repair changed frozen inputs: ${frozenChanges.join(', ')}`);
                this.checkControlPlaneScope(
                  changedPathsBetween(tree, candidate, repaired),
                  resolved.request,
                  node.logPath,
                );
                for (const member of preparedMembers) {
                  const erased = pathsChangedByTaskButUnchangedOnDev(
                    tree,
                    contributionBases.get(member.request.taskId)!,
                    repaired,
                    member.disposition.acceptedCommit,
                    member.outcome.changedFiles,
                  );
                  if (erased.length)
                    throw new Error(`Typing repair erased accepted contribution: ${erased.join(', ')}`);
                }
                assertIdentities();
                return repaired;
              },
              (head, result) => {
                git(tree, 'update-ref', `refs/goal/control-plane-proof/${batchId}/${key}/${node.attempts}`, head);
                (node.proofs ??= []).push({
                  candidate: head,
                  snapshot,
                  sources: node.indices.map((index) => manifest.members[index]!),
                  result,
                  completedAt: new Date().toISOString(),
                  scopeApprovals: scopeEvidence(node.indices),
                });
                save();
              },
              node.negativeProbes,
            );
            candidate = git(tree, 'rev-parse', 'HEAD');
            for (const member of preparedMembers) {
              member.outcome.mergedCommit = candidate;
              member.disposition.mergedCommit = candidate;
            }
            if (!proof.passed) {
              split(proof.output);
              break;
            }
            if (proof.moved) {
              appendFileSync(node.logPath, 'Captured refs moved; rebuilding bounded cohort\n');
              continue;
            }
            assertIdentities();
            if (!proof.lifecycleEvidence || !proof.compatibilityCommand)
              throw new Error('Control-plane batch has no exact native release evidence');
            const release = this.prepareControlPlaneRelease(
              preparedMembers[0]!.request,
              snapshot,
              candidate,
              proof.lifecycleEvidence,
              proof.compatibilityCommand,
              node.logPath,
            );
            if (!release.prepared) {
              if (!this.controlPlaneSnapshotMatches(snapshot)) continue;
              split(
                `Propagation from ${release.sourceBranch} into ${release.targetBranch}; files=[${release.conflicts?.join(', ') ?? ''}]; ${release.cause}`,
              );
              break;
            }
            const record = release.prepared.record;
            for (const member of preparedMembers)
              member.outcome.hostMs = Math.round((Date.now() - started) / preparedMembers.length);
            record.batchId = batchId;
            record.scopeApprovals = scopeEvidence(node.indices);
            record.members = preparedMembers;
            node.prepared = release.prepared;
            // Record proof and candidate before any externally visible ref update.
            save();
            for (const member of preparedMembers) {
              o.queue.candidate(member.entryId, candidate);
              const source = member.disposition.acceptedCommit;
              const ownBase = git(tree, 'merge-base', snapshot.mainHead, source);
              store.planIntegration(
                member.request,
                snapshot.mainHead,
                candidate,
                git(tree, 'rev-list', '--reverse', `${ownBase}..${source}`).split('\n').filter(Boolean),
              );
              this.writeControlPlaneRecord(member.request, record);
            }
            const advanced = store.commitBatchMerge(
              preparedMembers.map((member) => ({ ...member.request, commit: candidate })),
              () => {
                o.beforeIntegrationAdvance?.();
                o.beforePromotionAdvance?.();
                assertIdentities();
                if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${snapshot.mainBranch}`)
                  throw new Error('Main checkout HEAD changed');
                if (!this.publishControlPlaneRelease(release.prepared!)) return '';
                for (const member of preparedMembers) o.queue.finish(member.entryId, member.outcome);
                return candidate;
              },
            );
            if (!advanced) {
              delete node.prepared;
              save();
              continue;
            }
            complete(record, node);
            return;
          } finally {
            try {
              git(o.mainCheckout, 'worktree', 'remove', '--force', tree);
            } catch (error) {
              appendFileSync(node.logPath, `Train tree cleanup deferred: ${tree}: ${error}\n`);
            }
          }
        }
        const children = journal.nodes[key]?.children;
        if (children) for (const child of children) await visit(child);
      };
      await visit(continuation ? refContinuationNode : 'root');
      return {
        batchId,
        members: manifest.members.map((member) => journal.results.find((result) => result.taskId === member.taskId)!),
      };
    }
  }

  private formatControlPlaneCandidate(tree: string, changed: readonly string[], logPath: string): void {
    const command = this.options.formatCommand ?? [
      resolve(this.options.mainCheckout, 'node_modules/.bin/oxfmt'),
      ...FORMAT_FLAGS,
    ];
    const files = changed.filter((path) => existsSync(join(tree, path)));
    if (!files.length || (command[0]!.endsWith('/node_modules/.bin/oxfmt') && !existsSync(command[0]!))) return;
    const formatted = spawnSync(command[0]!, [...command.slice(1), ...files], { cwd: tree, encoding: 'utf8' });
    appendFileSync(logPath, `$ ${command.join(' ')}\n${formatted.stdout ?? ''}${formatted.stderr ?? ''}\n`);
    if (formatted.status !== 0)
      throw new Error(`Formatter failed: ${formatted.stderr || formatted.error || formatted.status}`);
    const altered = changedWorkingFiles(tree);
    if (altered.some((path) => !files.includes(path)))
      throw new Error(`Formatter changed unrelated files: ${altered.join(', ')}`);
    if (altered.length) {
      stagePaths(tree, altered);
      git(tree, 'commit', '-m', 'style: format accepted control-plane cohort');
    }
  }

  /** The single native proof authority for both individual releases and combined final heads. */
  private async verifyControlPlaneCandidate(
    tree: string,
    candidate: string,
    snapshot: ControlPlaneReleaseSnapshot,
    logPath: string,
    repairTyping?: (output: string) => Promise<string | undefined>,
    record?: (candidate: string, result: ControlPlaneProof) => void,
    negativeProbes: readonly string[][] = [],
    custody?: OrdinaryProofCustody,
  ): Promise<ControlPlaneProof> {
    const o = this.options;
    const runner = o.runControlPlaneGate ?? o.runGate ?? gateRunner(600_000, o.stateDirectory);
    const run = custody ? custody.run(runner) : runner;
    const integrity = (cwd: string, head: string, phase: string) =>
      assertCandidateIntegrity(cwd, head, phase, logPath, o.runCandidateGit);
    const moved = () => !this.controlPlaneSnapshotMatches(snapshot);
    const finish = (result: ControlPlaneProof): ControlPlaneProof => {
      // Failure evidence is durable before publication-ref movement can request a rebuild.
      record?.(candidate, result);
      return { ...result, ...(moved() ? { moved: true } : {}) };
    };
    appendFileSync(logPath, `\nControl-plane checks on ${candidate}, main ${snapshot.mainHead}\n`);
    const installs = await runIntegrationChecks(CONTROL_PLANE_CHECKS.slice(0, 2), tree, logPath, run);
    integrity(tree, candidate, 'control-plane dependency installs');
    if (!installs.passed) return finish(installs);
    // At most one bounded file probe inherited from the failed parent's actual full-suite output.
    // A green or inconclusive probe always falls through to every mandatory full-head check.
    for (const command of negativeProbes.slice(0, 1)) {
      const files = command.slice(4);
      if (!files.length || files.some((file) => !existsSync(join(tree, file)))) continue;
      const probe = await runIntegrationChecks(
        [command],
        tree,
        logPath,
        o.runControlPlaneGate ?? o.runGate ?? gateRunner(60_000, o.stateDirectory),
      );
      integrity(tree, candidate, 'negative-only bisection probe');
      if (!probe.passed && !probe.timedOut) return finish({ ...probe, negativeOnly: true });
    }
    let validation: Awaited<ReturnType<typeof runIntegrationChecks>>;
    if (repairTyping) {
      let typing = await runIntegrationChecks(CONTROL_PLANE_CHECKS.slice(2, 3), tree, logPath, run);
      integrity(tree, candidate, 'control-plane typecheck');
      if (installs.passed && !typing.passed && !typing.timedOut && !moved()) {
        const repaired = await repairTyping(typing.output);
        if (repaired) {
          candidate = repaired;
          typing = await runIntegrationChecks(CONTROL_PLANE_CHECKS.slice(2, 3), tree, logPath, run);
          integrity(tree, candidate, 'control-plane repaired typecheck');
        }
      }
      validation =
        typing.passed && installs.passed
          ? await runIntegrationChecks(CONTROL_PLANE_CHECKS.slice(3), tree, logPath, run)
          : typing;
    } else validation = await runIntegrationChecks(CONTROL_PLANE_CHECKS.slice(2), tree, logPath, run);
    integrity(tree, candidate, 'control-plane typecheck and test suite');
    const checked = {
      passed: installs.passed && validation.passed,
      output: installs.output + validation.output,
      timedOut: installs.timedOut || validation.timedOut,
      ...((installs.failedCommand ?? validation.failedCommand)
        ? { failedCommand: installs.failedCommand ?? validation.failedCommand }
        : {}),
    };
    if (!checked.passed || moved()) return finish(checked);
    integrity(tree, candidate, 'control-plane verification');
    const devTree = resolve(o.worktreeRoot, `control-plane-dev-${randomUUID()}`);
    const compatibilityCommand = ['bun', 'tools/goal/scripts/check-compatibility.ts', '--scripts-root', devTree];
    git(o.mainCheckout, 'worktree', 'add', '--detach', devTree, snapshot.devHead);
    try {
      appendFileSync(logPath, `\nMain control-plane compatibility against dev script tree ${snapshot.devHead}\n`);
      const devInstall = await runIntegrationChecks([['bun', 'install', '--frozen-lockfile']], devTree, logPath, run);
      integrity(tree, candidate, 'control-plane dev compatibility install');
      integrity(devTree, snapshot.devHead, 'control-plane dev compatibility install');
      if (!devInstall.passed || moved()) return finish(devInstall);
      const compatibility = await runIntegrationChecks([compatibilityCommand], tree, logPath, run);
      integrity(tree, candidate, 'main-dev compatibility contract');
      integrity(devTree, snapshot.devHead, 'main-dev compatibility contract');
      if (!compatibility.passed || moved()) return finish(compatibility);
    } finally {
      git(o.mainCheckout, 'worktree', 'remove', '--force', devTree);
    }
    appendFileSync(logPath, '\nComplete real-boundary lifecycle suite on control-plane candidate\n');
    const smokeCommand = ['bun', 'tools/goal/scripts/launch-smoke.ts', '--expected-dev-script-tree', snapshot.devHead];
    const smokeRunner = o.runLaunchSmoke ?? gateRunner(300_000);
    const smoke = await runIntegrationChecks(
      [smokeCommand],
      tree,
      logPath,
      custody ? custody.run(smokeRunner) : smokeRunner,
    );
    integrity(tree, candidate, 'launch smoke');
    const prefix = `release evidence: candidate=${candidate} dev-script-tree=${snapshot.devHead}`;
    const lifecycleEvidence = smoke.output.split(/\r?\n/).find((line) => line.startsWith(prefix));
    if (!smoke.passed || !lifecycleEvidence) {
      const timedOut =
        smoke.timedOut ||
        (smoke.passed && !lifecycleEvidence) ||
        /infrastructure\/unverified|exceeded the smoke time budget|smoke budget exhausted/i.test(smoke.output);
      if (timedOut) appendFileSync(logPath, 'Lifecycle suite result classified as infrastructure/unverified\n');
      return finish({
        passed: false,
        timedOut,
        failedCommand: smokeCommand,
        output: !smoke.passed ? smoke.output : `Lifecycle smoke omitted exact release evidence: ${prefix}`,
      });
    }
    appendFileSync(
      logPath,
      `Verified ${lifecycleEvidence}; compatibility command passed: ${compatibilityCommand.join(' ')}\n`,
    );
    return finish({ passed: true, timedOut: false, output: smoke.output, lifecycleEvidence, compatibilityCommand });
  }

  private controlPlaneSnapshot(mainBranch: string): ControlPlaneReleaseSnapshot {
    const checkout = this.options.mainCheckout;
    const devBranch = this.options.integrationBranch ?? 'dev';
    const stabilizeBranch =
      this.options.stabilizeBranch ?? localBranchSettings(checkout).stabilizeBranch ?? 'stabilize';
    const mainHead = this.refHead(mainBranch);
    if (!mainHead) throw new Error(`Control-plane release requires ${mainBranch}`);
    const devHead = this.ensureBranch(devBranch);
    const stabilizeHead = this.refHead(stabilizeBranch);
    return {
      mainBranch,
      mainHead,
      stabilizeBranch,
      ...(stabilizeHead ? { stabilizeHead } : {}),
      devBranch,
      devHead,
    };
  }

  private refHead(branch: string): string | undefined {
    const result = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: this.options.mainCheckout,
      encoding: 'utf8',
    });
    if (result.status === 0) return result.stdout.trim();
    if (result.status === 128) return undefined;
    throw new Error(result.stderr?.trim() || result.error?.message || `Cannot read ${branch}`);
  }

  private controlPlaneSnapshotMatches(snapshot: ControlPlaneReleaseSnapshot): boolean {
    return (
      this.refHead(snapshot.mainBranch) === snapshot.mainHead &&
      this.refHead(snapshot.stabilizeBranch) === snapshot.stabilizeHead &&
      this.refHead(snapshot.devBranch) === snapshot.devHead
    );
  }

  private controlPlaneRecordPath(request: LandingRequest): string {
    const key = createHash('sha256').update(`${request.taskId}\0${request.attempt}`).digest('hex');
    return join(this.options.stateDirectory, `control-plane-release-${key}.json`);
  }

  private controlPlaneConflictPath(taskId: string): string {
    const key = createHash('sha256').update(taskId).digest('hex');
    return join(this.options.stateDirectory, `control-plane-conflict-${key}.json`);
  }

  private readControlPlaneRecord(request: LandingRequest): ControlPlaneReleaseRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(this.controlPlaneRecordPath(request), 'utf8')) as ControlPlaneReleaseRecord;
      if (
        value.version === 1 &&
        value.taskId === request.taskId &&
        value.attempt === request.attempt &&
        typeof value.mainCommit === 'string' &&
        typeof value.devScriptTree === 'string' &&
        typeof value.devCommit === 'string' &&
        typeof value.lifecycleEvidence === 'string' &&
        Array.isArray(value.compatibilityCommand)
      )
        return value;
    } catch {
      // A missing or incomplete record cannot certify recovery.
    }
    return undefined;
  }

  private writeControlPlaneRecord(request: LandingRequest, record: ControlPlaneReleaseRecord): void {
    const path = this.controlPlaneRecordPath(request);
    mkdirSync(this.options.stateDirectory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private controlPlaneRecordPublished(record: ControlPlaneReleaseRecord): boolean {
    if (
      this.refHead(record.mainBranch) === undefined ||
      !this.commitIsAncestor(record.mainCommit, record.mainBranch) ||
      !this.commitIsAncestor(record.devCommit, record.devBranch)
    )
      return false;
    if (record.stabilizeCommit && !this.commitIsAncestor(record.stabilizeCommit, record.stabilizeBranch)) return false;
    if (!record.stabilizeCommit && this.refHead(record.stabilizeBranch) !== undefined) return false;
    return record.lifecycleEvidence.includes(
      `release evidence: candidate=${record.mainCommit} dev-script-tree=${record.devScriptTree}`,
    );
  }

  private mergeControlPlaneCandidate(
    sourceCommit: string,
    sourceBranch: string,
    targetBranch: string,
    targetHead: string,
    logPath: string,
  ): { commit?: string; conflicts?: string[]; cause?: string } {
    if (isAncestor(this.options.mainCheckout, sourceCommit, targetHead)) return { commit: targetHead };
    const tree = resolve(this.options.worktreeRoot, `control-plane-merge-${randomUUID()}`);
    mkdirSync(resolve(this.options.worktreeRoot), { recursive: true });
    try {
      git(this.options.mainCheckout, 'worktree', 'add', '--detach', tree, targetHead);
      const merged = candidateGit(
        tree,
        ['merge', '--no-ff', '--no-edit', '-m', `Merge ${sourceBranch} into ${targetBranch}`, sourceCommit],
        this.options.runCandidateGit,
      );
      const cause = `${merged.stdout ?? ''}${merged.stderr ?? ''}`.trim() || merged.error?.message || '';
      if (merged.status !== 0) {
        const conflicts = git(tree, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
        try {
          git(tree, 'merge', '--abort');
        } catch {
          // The merge may have failed before Git opened a merge state.
        }
        const message =
          `Prepared control-plane merge ${sourceBranch} ${sourceCommit} into ${targetBranch} failed` +
          `${conflicts.length ? ` on ${conflicts.join(', ')}` : ''}: ${cause || 'merge failed without conflict paths'}`;
        appendFileSync(logPath, `${message}\n`);
        return conflicts.length ? { conflicts, cause: cause || message } : { cause: message };
      }
      return { commit: git(tree, 'rev-parse', 'HEAD') };
    } finally {
      try {
        git(this.options.mainCheckout, 'worktree', 'remove', '--force', tree);
      } catch {
        rmSync(tree, { recursive: true, force: true });
      }
    }
  }

  private prepareControlPlaneRelease(
    request: LandingRequest,
    snapshot: ControlPlaneReleaseSnapshot,
    candidate: string,
    lifecycleEvidence: string,
    compatibilityCommand: string[],
    logPath: string,
  ): {
    prepared?: PreparedControlPlaneRelease;
    conflicts?: string[];
    sourceBranch?: string;
    targetBranch?: string;
    cause?: string;
  } {
    if (!this.controlPlaneSnapshotMatches(snapshot)) return {};
    let stabilizeCommit: string | undefined;
    let devSource = candidate;
    let sourceBranch = snapshot.mainBranch;
    if (snapshot.stabilizeHead) {
      const stable = this.mergeControlPlaneCandidate(
        candidate,
        snapshot.mainBranch,
        snapshot.stabilizeBranch,
        snapshot.stabilizeHead,
        logPath,
      );
      if (!stable.commit)
        return {
          ...(stable.conflicts ? { conflicts: stable.conflicts } : {}),
          sourceBranch: snapshot.mainBranch,
          targetBranch: snapshot.stabilizeBranch,
          cause: stable.cause ?? 'merge failed without a Git result',
        };
      stabilizeCommit = stable.commit;
      devSource = stable.commit;
      sourceBranch = snapshot.stabilizeBranch;
    } else {
      appendFileSync(
        logPath,
        `No ${snapshot.stabilizeBranch} branch exists; preparing ${snapshot.mainBranch} directly into ${snapshot.devBranch}.\n`,
      );
    }

    const dev = this.mergeControlPlaneCandidate(devSource, sourceBranch, snapshot.devBranch, snapshot.devHead, logPath);
    if (!dev.commit)
      return {
        ...(dev.conflicts ? { conflicts: dev.conflicts } : {}),
        sourceBranch,
        targetBranch: snapshot.devBranch,
        cause: dev.cause ?? 'merge failed without a Git result',
      };

    const record: ControlPlaneReleaseRecord = {
      version: 1,
      taskId: request.taskId,
      attempt: request.attempt,
      mainBranch: snapshot.mainBranch,
      mainCommit: candidate,
      mainExpected: snapshot.mainHead,
      devBranch: snapshot.devBranch,
      devScriptTree: snapshot.devHead,
      devCommit: dev.commit,
      stabilizeBranch: snapshot.stabilizeBranch,
      ...(snapshot.stabilizeHead ? { stabilizeExpected: snapshot.stabilizeHead } : {}),
      ...(stabilizeCommit ? { stabilizeCommit } : {}),
      lifecycleEvidence,
      compatibilityCommand,
      recordedAt: new Date().toISOString(),
    };
    appendFileSync(
      logPath,
      `Prepared control-plane release candidate=${candidate} dev-script-tree=${snapshot.devHead}` +
        `${stabilizeCommit ? ` stabilize=${stabilizeCommit}` : ''} dev=${dev.commit}\n`,
    );
    return { prepared: { snapshot, record } };
  }

  private publishControlPlaneRelease(prepared: PreparedControlPlaneRelease): boolean {
    const { snapshot, record } = prepared;
    if (!this.controlPlaneSnapshotMatches(snapshot)) return false;
    const updates = [
      { branch: snapshot.mainBranch, old: snapshot.mainHead, next: record.mainCommit },
      ...(snapshot.stabilizeHead
        ? [{ branch: snapshot.stabilizeBranch, old: snapshot.stabilizeHead, next: record.stabilizeCommit! }]
        : []),
      { branch: snapshot.devBranch, old: snapshot.devHead, next: record.devCommit },
    ];
    const references = [
      ...updates.map(({ branch }) => `refs/heads/${branch}`),
      ...(!snapshot.stabilizeHead ? [`refs/heads/${snapshot.stabilizeBranch}`] : []),
    ];
    const lines = ['start'];
    for (const reference of references) {
      const valid = spawnSync('git', ['check-ref-format', reference], {
        cwd: this.options.mainCheckout,
        encoding: 'utf8',
      });
      if (valid.status !== 0) throw new Error(`Invalid control-plane release ref: ${reference}`);
    }
    for (const update of updates) {
      const reference = `refs/heads/${update.branch}`;
      lines.push(
        update.old === update.next
          ? `verify ${reference} ${update.old}`
          : `update ${reference} ${update.next} ${update.old}`,
      );
    }
    if (!snapshot.stabilizeHead)
      lines.push(`verify refs/heads/${snapshot.stabilizeBranch} ${'0'.repeat(snapshot.mainHead.length)}`);
    if (record.source) {
      const branch = `refs/heads/${record.source.branch}`;
      const valid = spawnSync('git', ['check-ref-format', branch], { cwd: this.options.mainCheckout });
      if (valid.status !== 0 || references.includes(branch)) throw new Error(`Invalid release source ref: ${branch}`);
      lines.push(`verify ${branch} ${record.source.commit}`);
    }
    for (const member of record.members ?? []) {
      const branch = `refs/heads/${member.request.branch}`;
      const valid = spawnSync('git', ['check-ref-format', branch], { cwd: this.options.mainCheckout });
      if (valid.status !== 0 || references.includes(branch)) throw new Error(`Invalid batch source ref: ${branch}`);
      lines.push(`verify ${branch} ${member.disposition.acceptedCommit}`);
    }
    lines.push('prepare', 'commit');
    const transaction = spawnSync('git', ['update-ref', '--stdin'], {
      cwd: this.options.mainCheckout,
      encoding: 'utf8',
      input: `${lines.join('\n')}\n`,
    });
    if (transaction.status === 0) {
      rmSync(join(this.options.stateDirectory, 'control-plane-conflict.json'), { force: true });
      rmSync(this.controlPlaneConflictPath(record.taskId), { force: true });
      return true;
    }
    if (!this.controlPlaneSnapshotMatches(snapshot)) return false;
    throw new Error(
      `Atomic control-plane ref transaction failed: ${transaction.stderr?.trim() || transaction.error?.message || transaction.stdout?.trim() || transaction.status}`,
    );
  }

  private syncMainCheckout(branch: string, knownHeads: readonly string[]): void {
    const checkout = this.options.mainCheckout;
    if (git(checkout, 'symbolic-ref', 'HEAD') !== `refs/heads/${branch}`)
      throw new Error(`Main checkout HEAD changed; expected refs/heads/${branch}`);
    const currentHead = this.refHead(branch);
    if (!currentHead) throw new Error(`Main checkout branch ${branch} disappeared during control-plane release`);
    const indexTree = git(checkout, 'write-tree');
    const allowedTrees = new Set(
      [currentHead, ...knownHeads].map((head) => git(checkout, 'rev-parse', `${head}^{tree}`)),
    );
    if (!allowedTrees.has(indexTree))
      throw new Error('Main checkout index changed before control-plane release synchronization');
    const worktreeDiff = spawnSync('git', ['diff', '--quiet'], { cwd: checkout, encoding: 'utf8' });
    if (worktreeDiff.status !== 0)
      throw new Error('Main checkout has tracked worktree changes before control-plane release synchronization');
    git(checkout, 'reset', '--hard', `refs/heads/${branch}`);
  }
}
