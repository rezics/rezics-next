import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import defaults from '../defaults.json';
import { matchesPath, readRiskOwnership } from './briefs.ts';
import { StaleAttemptError } from './contracts.ts';
import type { AttemptFence, AttemptRef, GateOutcome, GateOutcomeSink, GateStage, LandingRequest } from './contracts.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SqliteLandingQueue, type LandingEntry } from './land.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import type { IntegrationTarget, Task } from './types.ts';
import { WorkerStore } from './store.ts';
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
  nonGeneratedFiles,
  outsideScope,
  type GateResult,
  type GateRunner,
} from './merge.ts';

import type { AffectedTestResult } from './types.ts';
import { CHECK_HOST_TRANSPORT } from './records.ts';

export type DerivedFile = { path: string; stage: 'integration' | 'promotion'; command: string[] };
export type IntegrationCheck = { paths: string[]; command: string[] };
import { resolveImportConflicts } from './import-conflicts.ts';
import { resolveInsertedSections } from './section-conflicts.ts';
const defaultDerivedFiles = defaults.derivedFiles as DerivedFile[];
/** A landing may change only files the formatter does not handle, such as SQL; that is not a formatter failure. */
export const FORMAT_FLAGS = ['--no-error-on-unmatched-pattern'];

/** Kernel's lane runner prints failed-file summaries; passing file headings and stack frames are not failures. */
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

/** No wall timeout: a check waiting for a shared host slot is still queued. */
export async function runAffectedTest(
  command: readonly string[],
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv,
): Promise<AffectedTestResult> {
  const started = Date.now();
  let output = '';
  let passed = false;
  let transportUnverified = false;
  let environmentUnverified = false;
  for (let retry = 0; retry < 2; retry++) {
    appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
    const result = await new Promise<{ passed: boolean; output: string }>((done) => {
      let captured = '';
      const child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = (chunk: Buffer) => {
        captured += chunk.toString();
        appendFileSync(logPath, chunk);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', (error) => done({ passed: false, output: String(error) }));
      child.once('close', (code) => done({ passed: code === 0, output: captured }));
    });
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
  const parallel = await Promise.all(
    rest.map(async (command, index) => {
      const own = `${logPath}.check-${index}`;
      writeFileSync(own, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
      const started = Date.now();
      const result = await execute(command, cwd, own);
      return { command, result, started, own };
    }),
  );
  for (const { command, result, started, own } of parallel) {
    appendFileSync(logPath, readFileSync(own, 'utf8'));
    rmSync(own, { force: true });
    record(command, result, started);
  }
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

function changedWorkingFiles(cwd: string): string[] {
  const tracked = spawnSync('git', ['diff', '--name-only', '-z', 'HEAD', '--'], { cwd, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  if (tracked.status !== 0 || untracked.status !== 0) throw new Error('Cannot read generated file changes');
  return [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))];
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
const CONTROL_PLANE_CHECKS: readonly (readonly string[])[] = [
  ['bun', 'install', '--frozen-lockfile'],
  ['bun', 'install', '--frozen-lockfile', '--cwd', 'tools/goal'],
  ['bun', 'run', '--cwd', 'tools/goal', 'typecheck'],
  ['bun', 'test', 'tools/goal/src'],
];

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

/**
 * Resolve conflicts that have exactly one safe resolution: import-only hunks in code and insert-only hunks in Markdown.
 * Returns false, leaving every file for a person, when any file holds another kind of conflict.
 */
export function resolveMechanicalConflicts(
  cwd: string,
  paths: readonly string[],
  formatCommand?: readonly string[],
): boolean {
  const resolved = new Map<string, string>();
  for (const file of paths) {
    const path = join(cwd, file);
    if (!existsSync(path)) return false;
    let text: string | undefined;
    if (file.endsWith('.md')) {
      git(cwd, 'checkout', '--conflict=diff3', '--', file);
      text = resolveInsertedSections(readFileSync(path, 'utf8'));
    } else if (/\.[cm]?[jt]sx?$/.test(file)) text = resolveImportConflicts(readFileSync(path, 'utf8'));
    if (text === undefined) return false;
    resolved.set(path, text);
  }
  for (const [path, text] of resolved) writeFileSync(path, text);
  const format = formatCommand ?? [join(cwd, 'node_modules/.bin/oxfmt'), ...FORMAT_FLAGS];
  if (!format[0]!.endsWith('/node_modules/.bin/oxfmt') || existsSync(format[0]!))
    spawnSync(format[0]!, [...format.slice(1), ...paths], { cwd, encoding: 'utf8' });
  return true;
}

function rebaseWithDerivedFiles(
  cwd: string,
  base: string,
  originalBase: string,
  logPath: string,
  files: readonly DerivedFile[],
): unknown | undefined {
  try {
    git(cwd, '-c', 'rebase.updateRefs=false', 'rebase', '--onto', base, originalBase);
    return undefined;
  } catch (initialError) {
    let rebaseError: unknown = initialError;
    for (;;) {
      const conflicts = unmergedFiles(cwd);
      if (!conflicts.length) throw rebaseError;
      const derivedConflicts = conflicts.filter((path) => derivedForPath(path, files).length > 0);
      const textConflicts = conflicts.filter((path) => !derivedForPath(path, files).length);
      // A generated-file regeneration is safe only when it accounts for every conflict. A mixed conflict
      // must stay with the worker instead of silently choosing either side for part of the change.
      if (derivedConflicts.length && textConflicts.length) return rebaseError;
      if (textConflicts.length) {
        if (!resolveMechanicalConflicts(cwd, textConflicts)) return rebaseError;
        appendFileSync(logPath, `Rebase resolved import-only and insert-only conflicts: ${textConflicts.join(', ')}\n`);
        stagePaths(cwd, new Set(textConflicts));
      }

      for (const path of derivedConflicts) git(cwd, 'checkout', '--ours', '--', path);
      const integrationCommands = new Map<string, string[]>();
      for (const path of derivedConflicts)
        for (const file of derivedForPath(path, files)) {
          integrationCommands.set(JSON.stringify(file.command), file.command);
        }
      for (const command of integrationCommands.values()) {
        const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: 'utf8' });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n${output}`);
        if (result.status !== 0)
          throw new Error(`Failed to regenerate derived files: ${output || result.error?.message || 'command failed'}`);
      }
      const stageFiles = new Set(derivedConflicts);
      for (const path of changedWorkingFiles(cwd)) if (derivedForPath(path, files).length) stageFiles.add(path);
      stagePaths(cwd, stageFiles);
      try {
        git(cwd, '-c', 'core.editor=true', 'rebase', '--continue');
        return undefined;
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
): void {
  const upstream = rebaseUpstream(cwd, base, originalBase);
  const head = git(cwd, 'rev-parse', 'HEAD');
  // Files the worker's own commits touched: a squash may change these outside the allowed paths, never a file only
  // the target's history changed, which a wrong upstream would replay or revert.
  const own = new Set(git(cwd, 'log', '--name-only', '--format=', `${base}..${head}`).split('\n').filter(Boolean));
  const originalSubjects = git(cwd, 'log', '--format=%s', '--reverse', `${upstream}..HEAD`).split('\n').filter(Boolean);
  const initialConflict = rebaseWithDerivedFiles(cwd, base, upstream, logPath, files);
  if (initialConflict === undefined) return;

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
  if (squashedConflict !== undefined) throw squashedConflict;
}

export type TrainOptions = {
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  formatCommand?: string[];
  riskAreasFile?: string;
  affectedTests?: import('./types.ts').AffectedTestCheck[];
  /** Checks for landings into dev; a function is called for every landing, so a configuration change applies at once. */
  integrationChecks?: IntegrationCheck[] | (() => IntegrationCheck[]);
  /** Batched dev landings; absent integration settings retain one-at-a-time behavior. */
  integration?: { batchSize?: number };
  queue: SqliteLandingQueue;
  fence: AttemptFence;
  sink: GateOutcomeSink;
  derivedFiles?: DerivedFile[];
  runGate?: GateRunner;
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
    await Promise.all([start('main'), start('dev')]);
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
              const outcome = await this.integrate(entry);
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

              if (retryDeferred.has(entry.id) && outcome.stage === 'rebase' && outcome.conflictedFiles?.length) {
                deferred.add(entry.id);
                continue;
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
        await o.beforeRelease?.();
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
    if (!o.integrationBranch || !o.fence.commitBatchMerge) return false;
    if ((entry.request.affectedTests ?? []).some((test) => test.status === 'failed')) return false;
    const recorded = taskIntegrationTarget(o.stateDirectory, entry.request.taskId);
    return !recorded.workspace && recorded.target !== 'stabilize' && recorded.goal !== 'control-plane';
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

    while (pending.length) {
      const trainTree = resolve(o.worktreeRoot, `train-batch-${randomUUID()}`);
      const logPaths = new Map<number, string>();
      const memberStarted = new Map<number, number>();
      const prepared: PreparedLanding[] = [];
      const localOutcomes = new Map<number, GateOutcome>();
      let base = '';
      let previous = '';
      let added = false;
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
          const frozenPaths = new Set(frozenAtStart.map((file) => file.path));
          const worked =
            changedFrozenFiles(trainTree, frozenAtStart).length > 0 ||
            git(trainTree, 'diff', '--name-only', originalBase, 'HEAD')
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
              result.conflictedFiles = conflicts;
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
            result.stage = 'rebase';
            result.conflictedFiles = changedFrozen;
            result.firstFailure = firstFailure(`Frozen acceptance file changed: ${changedFrozen.join(', ')}`);
            appendFileSync(logPath, `Frozen acceptance files changed: ${changedFrozen.join(', ')}\n`);
            const mutable = o.fence as AttemptFence & {
              updateAttempt?: (ref: AttemptRef, update: (attempt: { escalation: string | null }) => void) => unknown;
            };
            mutable.updateAttempt?.(request, (attempt) => {
              attempt.escalation = 'rebase-conflict';
            });
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

        const configuredChecks =
          typeof o.integrationChecks === 'function' ? o.integrationChecks() : (o.integrationChecks ?? []);
        const changed = [...new Set(prepared.flatMap((member) => member.result.changedFiles))].sort();
        const integrationChecks = configuredChecks.filter((check) =>
          changed.some((path) => matchesPath(path, check.paths)),
        );
        let failedBatch: { output: string; timedOut: boolean; failedCommand?: readonly string[] } | undefined;
        let batchBaselineOutput = '';
        if (integrationChecks.length) {
          const commands = integrationChecks.map((check) =>
            check.command.join(' ').includes('scripts/typecheck.ts')
              ? ['env', `TYPECHECK_CHANGED=${changed.join('\n')}`, ...check.command]
              : check.command,
          );
          const candidate = prepared[prepared.length - 1]!.candidate;
          for (const member of prepared)
            appendFileSync(member.result.logPath, `\nBatch integration check on ${candidate}, dev ${base}\n`);
          const batchLog = logPaths.get(prepared[0]!.entry.id)!;
          const checked = await runIntegrationChecks(commands, trainTree, batchLog);
          for (const member of prepared)
            appendFileSync(
              member.result.logPath,
              `Batch integration check ${checked.passed ? 'passed' : 'failed'}${checked.timedOut ? ' (timed out)' : ''}\n${checked.output}`,
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
            const scoped = commands.some((command) => command[0] === 'env');
            const key = `integration-check:${JSON.stringify(integrationChecks)}${scoped ? `:${Bun.hash(changed.join('\n')).toString(16)}` : ''}`;
            let baseline = o.queue.baseline(base, key);
            o.queue.saveBaseline(candidate, key, checked);
            if (!baseline) {
              resetTo(trainTree, base);
              const baselineLog = logPaths.get(prepared[0]!.entry.id)!;
              appendFileSync(baselineLog, `\nIntegration check baseline on dev ${base}\n`);
              baseline = await runIntegrationChecks(commands, trainTree, baselineLog);
              o.queue.saveBaseline(base, key, baseline);
              batchBaselineOutput = baseline.output;
            }
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
            const addedErrors = baseline.passed
              ? ['candidate failed while dev passed']
              : newErrorLines(checked.output, baseline.output);
            if (addedErrors.length) failedBatch = checked;
            else
              for (const member of prepared)
                appendFileSync(
                  member.result.logPath,
                  'dev already fails the integration check, with the same errors\n',
                );
          }
        }

        if (failedBatch) {
          const note = `Batch integration check failed; falling back to single landings.\n${failedBatch.output}\n`;
          let savedBaseline = false;
          for (const entry of pending) {
            if (deferred.has(entry.id)) continue;
            try {
              const outcome = await this.integrate(entry);
              appendFileSync(
                outcome.logPath,
                `${note}${!savedBaseline && batchBaselineOutput ? `Batch baseline on dev ${base}:\n${batchBaselineOutput}\n` : ''}`,
              );
              savedBaseline ||= Boolean(batchBaselineOutput);
              if (outcome.stage === 'rebase' && outcome.conflictedFiles?.length) deferred.add(entry.id);
              else outcomes.set(entry.id, outcome);
            } catch (error) {
              if (!(error instanceof StaleAttemptError)) throw error;
              skipped.add(entry.id);
            }
          }
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
          git(o.mainCheckout, 'worktree', 'remove', '--force', trainTree);
        }
      }
      if (retry) continue;
    }
    return { outcomes: orderedOutcomes(), deferredIds: [...deferred], skippedIds: [...skipped] };
  }

  private async integrate(entry: LandingEntry): Promise<GateOutcome> {
    const o = this.options;
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
      recorded.target === 'stabilize'
        ? 'stabilize'
        : recorded.target === 'main' || o.integrationBranch === undefined
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
    const logPath = join(o.stateDirectory, `landing-${entry.id}.log`);
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
    const runGate = o.runGate ?? gateRunner();
    const target = () => git(o.mainCheckout, 'rev-parse', targetRef);
    const recoverAlreadyIntegrated = (): boolean => {
      if (!entry.candidate) return false;
      try {
        git(o.mainCheckout, 'merge-base', '--is-ancestor', entry.candidate, targetBranch);
      } catch {
        return false;
      }
      result.passed = true;
      result.stage = 'merge';
      result.mergedCommit = entry.candidate;
      if (workspace) workspace.integrated(recorded.workspace!.module, target());
      if (controlPlane) this.propagateControlPlaneCommit(entry.candidate, request.taskId, recorded.manager, logPath);
      else if (stabilize) {
        mkdirSync(resolve(o.worktreeRoot), { recursive: true });
        git(o.mainCheckout, 'worktree', 'add', '--detach', trainTree, entry.candidate);
        added = true;
        this.mergeStabilizedCommitIntoDev(entry.candidate, trainTree, request.taskId, recorded.manager, logPath);
      }
      return true;
    };
    try {
      o.fence.assertCurrent(request);
      if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
        throw new Error('The main checkout must already have main checked out');
      if (recoverAlreadyIntegrated()) return finish();
      const tip = git(o.mainCheckout, 'rev-parse', '--verify', `${request.branch}^{commit}`);
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

      // A worker branch starts on dev and a retry moves it onto a newer dev, so its own changes are those after its
      // fork from dev. The recorded base counted every landing in between: thousands of paths overflowed the diff and
      // other goals' files kept every retried control-plane task off main. Only the commits after the fork replay.
      let controlPlaneFork: string | undefined;
      if (
        !workspace &&
        recorded.goal === 'control-plane' &&
        recorded.target !== 'stabilize' &&
        o.integrationBranch !== undefined
      ) {
        const fork = git(o.mainCheckout, 'merge-base', tip, `refs/heads/${o.integrationBranch}`);
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
      if (recoverAlreadyIntegrated()) return finish();
      const originalBase = controlPlaneFork ?? git(o.mainCheckout, 'merge-base', tip, target());
      mkdirSync(resolve(o.worktreeRoot), { recursive: true });
      git(o.mainCheckout, 'worktree', 'add', '--detach', trainTree, tip);
      added = true;
      for (;;) {
        o.fence.assertCurrent(request);
        delete result.firstFailure;
        delete result.failsOnMain;
        delete result.timedOut;
        delete result.failedCommand;
        const base = target();
        stage = 'rebase';
        git(trainTree, 'reset', '--hard', tip);
        git(trainTree, 'clean', '-fdx');
        const derivedFiles = o.derivedFiles ?? defaultDerivedFiles;
        // A worker that left its work uncommitted would otherwise integrate nothing and release its dependents. The
        // controller commits the frozen acceptance files itself, so they are not the worker's work.
        const frozenAtStart = frozenFilesForTask(o.stateDirectory, request.taskId);
        const frozenPaths = new Set(frozenAtStart.map((file) => file.path));
        // A changed frozen file is the worker's doing; the frozen check below refuses it with its own reason.
        const worked =
          changedFrozenFiles(trainTree, frozenAtStart).length > 0 ||
          git(trainTree, 'diff', '--name-only', originalBase, 'HEAD')
            .split('\n')
            .some((path) => path && !frozenPaths.has(path));
        if (!worked)
          throw new Error(
            'No committed changes beyond the base and the frozen acceptance files: commit the work before finishing',
          );
        if (workspace) {
          git(trainTree, 'reset', '--hard', base);
          git(trainTree, 'merge', '--no-ff', '--no-edit', tip);
        } else rebaseOnto(trainTree, base, originalBase, logPath, derivedFiles, request.declaredPaths);
        const frozen = workspace
          ? sharedStore!
              .tasks()
              .filter((task) => task.workspace?.module === recorded.workspace!.module)
              .flatMap((task) => frozenFilesForTask(o.stateDirectory, task.id))
          : frozenFilesForTask(o.stateDirectory, request.taskId);
        const changedFrozen = changedFrozenFiles(trainTree, frozen);
        if (changedFrozen.length) {
          stage = 'rebase';
          result.stage = 'rebase';
          result.conflictedFiles = changedFrozen;
          result.firstFailure = firstFailure(`Frozen acceptance file changed: ${changedFrozen.join(', ')}`);
          appendFileSync(logPath, `Frozen acceptance files changed: ${changedFrozen.join(', ')}\n`);
          const mutable = o.fence as AttemptFence & {
            updateAttempt?: (ref: AttemptRef, update: (attempt: { escalation: string | null }) => void) => unknown;
          };
          if (workspace) {
            const owners = sharedTasks.filter((task) =>
              taskChangedPaths(task, tip).some((path) => changedFrozen.includes(path)),
            );
            attributeFailure(result, owners.length ? owners : undefined);
          } else
            mutable.updateAttempt?.(request, (attempt) => {
              attempt.escalation = 'rebase-conflict';
            });
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
            const formatted = spawnSync(formatCommand[0]!, [...formatCommand.slice(1), ...formatFiles], {
              cwd: trainTree,
              encoding: 'utf8',
            });
            const output = `${formatted.stdout ?? ''}${formatted.stderr ?? ''}`;
            appendFileSync(logPath, `$ ${[...formatCommand, ...formatFiles].join(' ')} (cwd: ${trainTree})\n${output}`);
            if (formatted.status !== 0)
              throw new Error(`Formatter failed: ${output || formatted.error?.message || 'command failed'}`);
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
        const affectedFailures: string[] = [];
        let baseTreeFiles: Set<string> | undefined;
        const affectedResults = workspace
          ? await Promise.all(
              (o.affectedTests ?? defaults.affectedTests)
                .filter((check) => result.changedFiles.some((path) => matchesPath(path, check.paths)))
                .map((check) =>
                  runAffectedTest(check.command, trainTree, logPath, {
                    ...gateEnvironment(process.env, o.stateDirectory),
                    KERNEL_CHECK_AFFECTED: base,
                  }),
                ),
            )
          : (request.affectedTests ?? []);
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
                const installed = await runAffectedTest(
                  ['bun', 'install', '--frozen-lockfile'],
                  baselineTree,
                  logPath,
                  environment,
                );
                if (installed.status !== 'passed')
                  throw new Error(`Affected-test baseline install failed: ${installed.output}`);
              }
              const measured = await runAffectedTest(baselineCommand, baselineTree, logPath, environment);
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
        if (target() !== base) continue;
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
        if (controlPlane) {
          stage = 'gate';
          appendFileSync(logPath, `\nControl-plane checks on ${candidate}, main ${base}\n`);
          let checked = await runIntegrationChecks(CONTROL_PLANE_CHECKS, trainTree, logPath, runGate);
          // The suite runs on the train's host beside every worker, and a timing test can fail under that load: two
          // landings of one task failed on two different tests that pass alone. As the kernel check does, failing
          // test files rerun alone once, and the check passes only if they pass alone.
          const suite = CONTROL_PLANE_CHECKS.at(-1)!;
          if (!checked.passed && !checked.timedOut && JSON.stringify(checked.failedCommand) === JSON.stringify(suite)) {
            const files = failingTestFiles(checked.output);
            if (files.length) {
              appendFileSync(logPath, `Rerunning failed control-plane test files alone: ${files.join(' ')}\n`);
              const alone = await runIntegrationChecks([['bun', 'test', ...files]], trainTree, logPath, runGate);
              if (alone.passed) {
                appendFileSync(logPath, 'Load-sensitive control-plane tests passed alone\n');
                checked = alone;
              }
            }
          }
          o.fence.assertCurrent(request);
          if (target() !== base) continue;
          if (!checked.passed) {
            result.timedOut = checked.timedOut;
            result.firstFailure = firstFailure(checked.output);
            if (checked.failedCommand) result.failedCommand = [...checked.failedCommand];
            result.stage = stage;
            return finish();
          }
          if (git(trainTree, 'rev-parse', 'HEAD') !== candidate)
            throw new Error('Control-plane checks changed the candidate commit');
          git(trainTree, 'diff', '--quiet', 'HEAD', '--');
        }
        const configuredChecks =
          typeof o.integrationChecks === 'function' ? o.integrationChecks() : (o.integrationChecks ?? []);
        const integrationChecks = configuredChecks.filter((check) =>
          result.changedFiles.some((path) => matchesPath(path, check.paths)),
        );
        if (!controlPlane && integratesIntoDev && integrationChecks.length) {
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
        if (workspace) {
          stage = 'gate';
          let failed = false;
          for (const task of sharedTasks) {
            appendFileSync(
              logPath,
              `Shared workspace acceptance for ${task.id}: ${task.brief.acceptance.command.join(' ')}\n`,
            );
            const checked = await runGate(task.brief.acceptance.command, trainTree, logPath);
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
        if (!integratesIntoDev && !controlPlane) {
          stage = 'gate';
          appendFileSync(logPath, `\nGate on ${candidate}, main ${base}\n`);
          const gated = await runGate(request.gate, trainTree, logPath);
          // A gate on an old main is never authoritative, including a red gate.
          o.fence.assertCurrent(request);
          if (target() !== base) continue;
          if (!gated.passed) {
            result.timedOut = gated.timedOut;
            result.firstFailure = firstFailure(gated.output);
            result.failedCommand = [...request.gate];
            const key = JSON.stringify([o.gateIdentity ?? '', request.gate]);
            let baseline = o.queue.baseline(base, key);
            if (!baseline) {
              git(trainTree, 'reset', '--hard', base);
              git(trainTree, 'clean', '-fdx');
              baseline = await runGate(request.gate, trainTree, logPath);
              o.queue.saveBaseline(base, key, baseline);
            }
            o.fence.assertCurrent(request);
            if (target() !== base) continue;
            result.failsOnMain =
              !baseline.passed && firstFailure(baseline.output).fingerprint === result.firstFailure.fingerprint;
            result.stage = stage;
            return finish();
          }
          // Gates may write files but may not replace the commit that was validated.
          if (git(trainTree, 'rev-parse', 'HEAD') !== candidate) throw new Error('Gate changed the candidate commit');
          git(trainTree, 'diff', '--quiet', 'HEAD', '--');
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
        if (target() !== base) continue;
        if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
          throw new Error('Main checkout HEAD changed while integrating');
        const advanced = o.fence.commitMerge(request, () => {
          // Retry uses the same BEGIN IMMEDIATE lock through this check, Git and task-state publication.
          if (target() !== base) return '';
          if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
            throw new Error('Main checkout HEAD changed');
          if (controlPlane) {
            o.beforeIntegrationAdvance?.();
            if (target() !== base) return '';
            // main is checked out in the main checkout, and the control plane runs from its files. Moving only the ref
            // left the files at an older tree: four landed control-plane fixes were not running for an hour and a half.
            git(o.mainCheckout, 'merge', '--ff-only', '--no-edit', candidate);
          } else if (integratesIntoDev) {
            o.beforeIntegrationAdvance?.();
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
        if (!advanced) continue;
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
          outsideScope(
            (workspace ? taskChangedPaths(sharedStore!.task(request.taskId), tip) : (result.changedFiles ?? [])).filter(
              (path) => !derivedForPath(path, derivedFiles).length,
            ),
            request.declaredPaths,
          ),
          candidate,
          targetBranch,
          logPath,
        );
        if (controlPlane) this.propagateControlPlaneCommit(candidate, request.taskId, recorded.manager, logPath);
        else if (stabilize)
          this.mergeStabilizedCommitIntoDev(candidate, trainTree, request.taskId, recorded.manager, logPath);
        return finish();
      }
    } catch (error) {
      if (error instanceof StaleAttemptError) throw error;
      const message = String(error);
      appendFileSync(logPath, `${message}\n`);
      result.stage = stage;
      if (stage === 'rebase' && added) result.conflictedFiles = unmergedFiles(trainTree);
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
        git(o.mainCheckout, 'worktree', 'remove', '--force', trainTree);
      }
    }
  }

  /** Publish a checked control-plane commit through the candidate branches without moving a ref past its current head. */
  private propagateControlPlaneCommit(
    mainCommit: string,
    taskId: string,
    managerId: string | undefined,
    logPath: string,
  ): void {
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
      const merged = this.mergeCommitIntoBranch(mainCommit, mainBranch, stabilizeBranch, logPath);
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

    const merged = this.mergeCommitIntoBranch(devSource, sourceBranch, devBranch, logPath);
    if (merged.conflicts) {
      this.notifyControlPlaneConflict(taskId, managerId, sourceBranch, devSource, devBranch, merged.conflicts);
      return;
    }
    if (merged.error) appendFileSync(logPath, `Cannot merge ${sourceBranch} into ${devBranch}: ${merged.error}\n`);
  }

  /** Build a non-fast-forward merge away from the checkout, then compare-and-swap the target ref. */
  private mergeCommitIntoBranch(
    sourceCommit: string,
    sourceBranch: string,
    targetBranch: string,
    logPath: string,
    runSync: SpawnText = spawnSync,
  ): { commit?: string; conflicts?: string[]; error?: string } {
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
        this.options.beforePromotionAdvance?.();
        try {
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
  ): void {
    const summary =
      `Task ${taskId} ${sourceBranch} ${sourceCommit} conflicts with ${targetBranch}: ${files.join(', ')}. ${targetBranch} was left unchanged.`.replace(
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

  /** Merge the new stabilize commit into dev. A conflict leaves stabilize advanced and wakes both managers. */
  private mergeStabilizedCommitIntoDev(
    candidate: string,
    trainTree: string,
    taskId: string,
    managerId: string | undefined,
    logPath: string,
  ): void {
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
    if (!resolveMechanicalConflicts(tree, files, formatCommand)) return false;
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
    if (!files.length) return;
    const shared = (this.options.fence as AttemptFence & { db?: Database }).db;
    const path = join(this.options.stateDirectory, 'goal.sqlite');
    const owned = shared || !existsSync(path) ? undefined : openDb(path);
    const db = shared ?? owned;
    if (!db) return;
    try {
      type Row = { id: string; state?: string; brief?: { goal?: string; manager?: string; paths?: string[] } };
      const tasks = (db.query('SELECT body FROM worker_tasks').all() as { body: string }[])
        .map((row) => JSON.parse(row.body) as Row)
        .filter((task) => task.state !== 'cancelled' && task.brief?.goal && task.brief.paths?.length);
      const own = tasks.find((task) => task.id === request.taskId)?.brief?.goal;
      const literal = (pattern: string) => pattern.split(/[*?[{]/, 1)[0]!.length;
      const byManager = new Map<string, string[]>();
      for (const file of files) {
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
        if (own && goals.has(own)) continue;
        for (const manager of owners) byManager.set(manager, [...(byManager.get(manager) ?? []), file]);
      }
      if (!byManager.size) return;
      const inbox = new SqliteManagerInbox(
        db,
        this.options.inboxDirectory ?? join(this.options.stateDirectory, 'inboxes'),
      );
      for (const [manager, changed] of byManager) {
        const summary =
          `Task ${request.taskId}${own ? ` (${own})` : ''} changed files your tasks declare, outside its own paths, now on ${branch} ${commit}: ${changed.join(', ')}. Its landing ran only its own acceptance: check these against your tests.`.replace(
            /[\r\n]+/g,
            ' ',
          );
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
}
