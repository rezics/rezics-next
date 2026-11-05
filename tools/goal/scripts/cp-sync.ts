#!/usr/bin/env bun
/**
 * cp-sync makes dev's control plane live on main without the main-release proof. It checks dev's `tools/goal` on a
 * temporary worktree of main, then publishes it to main, stabilize and dev in one compare-and-swap transaction and
 * updates the main checkout's working tree. See "Control plane on dev: cp-sync" in tools/goal/README.md.
 *
 * Policy helpers and the resident unit list are imported from the source checkout; older target checkouts need no runtime composition.
 */
import { readScriptPolicy, scriptPolicy, withScriptPolicy } from '../src/script-policy.ts';
import { type ControlPolicy } from '../src/policy.ts';
import { RESIDENT_CODE_UNITS } from '../src/service.ts';
import {
  planCpSyncRefs,
  publishCpSyncRefs,
  type CpSyncRefTransactionContext,
  type RefUpdate,
} from '../src/cp-sync-ref-transaction.ts';
import {
  type Baseline,
  type Check,
  SMOKE_STATE,
  assertNotDatabase,
  baselineFile,
  checksKey,
  childEnvironment,
  comparable,
  copyDatabase,
  gate,
  readBaseline,
  redact,
  reportStep,
  runCheck,
  runChecks,
  stopOwnedCheck,
  summarizeTests,
  syncChecks,
  writeBaseline,
} from './cp-sync-checks.ts';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';

export {
  type Baseline,
  type Check,
  type Gate,
  type StepResult,
  type TestSummary,
  PROOF_CHECKS,
  SMOKE_STATE,
  childEnvironment,
  cliSmoke,
  configSmoke,
  redact,
  runCheck,
  summarizeTests,
  syncChecks,
} from './cp-sync-checks.ts';

export const CONTROL_PLANE = 'tools/goal';
const MAIN = 'main';
const DEV = 'dev';
const STABILIZE = 'stabilize';
// Git SHA-1 identity width; short hashes and baseline hashes below are persistent display/cache identities.
const ZERO = '0'.repeat(40);

export class Refusal extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Git

type Result = { status: number; stdout: string; stderr: string };

function run(cwd: string, args: readonly string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Result {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...(options.input === undefined ? {} : { input: options.input }),
    env: { ...childEnvironment(), ...options.env },
    maxBuffer: scriptPolicy().cpSync.gitBufferBytes,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${redact(result.stderr.trim())}`);
  return result.stdout.trim();
}

function head(cwd: string, branch: string): string | undefined {
  const result = run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function object(cwd: string, revision: string, path: string): string | undefined {
  const result = run(cwd, ['rev-parse', '--verify', '--quiet', `${revision}:${path}`]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const isAncestor = (cwd: string, ancestor: string, descendant: string) =>
  run(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
const short = (sha: string) => sha.slice(0, 10);

function changedPaths(cwd: string, from: string, to: string, paths: readonly string[] = []): string[] {
  return git(cwd, 'diff', '--name-only', '-z', from, to, '--', ...paths)
    .split('\0')
    .filter(Boolean);
}

/** The tree of `base` with each of `paths` taken from `source` (or removed where `source` lacks it). */
function replacePaths(cwd: string, base: string, source: string, paths: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'cp-sync-index-'));
  const env = { GIT_INDEX_FILE: join(directory, 'index') };
  const step = (args: string[], input?: string) => {
    const result = run(cwd, args, input === undefined ? { env } : { env, input });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${redact(result.stderr.trim())}`);
    return result.stdout;
  };
  try {
    step(['read-tree', base]);
    const present = step(['ls-files', '-z', '--', ...paths])
      .split('\0')
      .filter(Boolean);
    if (present.length) step(['update-index', '-z', '--index-info'], present.map((p) => `0 ${ZERO}\t${p}\0`).join(''));
    const entries = step(['ls-tree', '-r', '-z', '--full-tree', source, '--', ...paths]);
    if (entries) step(['update-index', '-z', '--index-info'], entries);
    return step(['write-tree']).trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function commitTree(cwd: string, tree: string, parents: readonly string[], message: string): string {
  return git(cwd, 'commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message);
}

/** The single checkout that has main checked out, which runs the live control plane. */
export function findMainCheckout(cwd: string): string {
  const listing = git(cwd, 'worktree', 'list', '--porcelain');
  const matches = listing
    .split('\n\n')
    .map((block) => block.split('\n'))
    .filter((lines) => lines.includes(`branch refs/heads/${MAIN}`))
    .map((lines) => lines.find((line) => line.startsWith('worktree '))!.slice('worktree '.length));
  if (matches.length !== 1)
    throw new Refusal(`Expected exactly one checkout with ${MAIN} checked out; found ${matches.length}.`);
  return matches[0]!;
}

/** Tracked, staged and untracked-but-not-ignored changes under `paths` in the main checkout. */
function uncommitted(checkout: string, paths: readonly string[]): string[] {
  run(checkout, ['update-index', '-q', '--refresh']);
  return git(checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths)
    .split('\0')
    .filter(Boolean);
}

function assertCheckoutReady(checkout: string, expectedHead: string, paths: readonly string[]): void {
  if (run(checkout, ['symbolic-ref', 'HEAD']).stdout.trim() !== `refs/heads/${MAIN}`)
    throw new Refusal(`The main checkout ${checkout} must have ${MAIN} checked out.`);
  const now = head(checkout, MAIN);
  if (now !== expectedHead) throw new Refusal(`${MAIN} moved from ${short(expectedHead)} to ${now}; run again.`);
  const dirty = uncommitted(checkout, paths);
  if (dirty.length)
    throw new Refusal(
      `The main checkout has uncommitted changes under ${paths.join(', ')}:\n${dirty
        .slice(0, scriptPolicy().cpSync.dirtyPaths)
        .map((line) => `  ${line}`)
        .join(
          '\n',
        )}${dirty.length > scriptPolicy().cpSync.dirtyPaths ? `\n  ... ${dirty.length - scriptPolicy().cpSync.dirtyPaths} more` : ''}`,
    );
}

function refTransactionContext(checkout: string): CpSyncRefTransactionContext {
  return {
    checkout,
    main: MAIN,
    dev: DEV,
    stabilize: STABILIZE,
    conflictPathLimit: scriptPolicy().cpSync.conflictPaths,
    git: (...args) => git(checkout, ...args),
    run: (args, options) => run(checkout, args, options),
    head: (branch) => head(checkout, branch),
    isAncestor: (ancestor, descendant) => isAncestor(checkout, ancestor, descendant),
    changedPaths: (from, to, paths) => changedPaths(checkout, from, to, paths),
    replacePaths: (base, source, paths) => replacePaths(checkout, base, source, paths),
    commitTree: (tree, parents, message) => commitTree(checkout, tree, parents, message),
    assertCheckoutReady: (expectedHead, paths) => assertCheckoutReady(checkout, expectedHead, paths),
    refuse: (message) => {
      throw new Refusal(message);
    },
    short,
    redact,
  };
}

/** Stops processes left running inside a worktree, such as detached test fixtures in their own process groups. */
function stopProcessesIn(directory: string): number {
  let stopped = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${entry}/cwd`).replace(/ \(deleted\)$/, '');
    } catch {
      continue;
    }
    if (cwd !== directory && !cwd.startsWith(`${directory}/`)) continue;
    try {
      process.kill(Number(entry), 'SIGTERM');
      stopped++;
    } catch {}
  }
  return stopped;
}

// ---------------------------------------------------------------------------------------------------------------
// Root files the control plane reaches outside tools/goal

export type RootReference = {
  path: string;
  runtime: boolean;
  status: 'same' | 'differs' | 'dev only' | 'main only';
  from: string;
};

const RELATIVE_LITERAL = /(['"`])(\.{1,2}\/[^'"`\s]*)\1/g;
const isTestFile = (path: string) => /\.test\.tsx?$|\/test-[\w-]+\.ts$|\/fixtures\//.test(path);

function trackedFiles(cwd: string, revision: string): Set<string> {
  return new Set(git(cwd, 'ls-tree', '-r', '--name-only', '-z', revision).split('\0').filter(Boolean));
}

function readBlob(cwd: string, revision: string, path: string): string | undefined {
  const result = run(cwd, ['cat-file', 'blob', `${revision}:${path}`]);
  return result.status === 0 ? result.stdout : undefined;
}

/**
 * Root files that `source`'s tools/goal loads by a relative path (imports and `import.meta.dir` joins), followed
 * through those files' own relative imports, with how main's copy compares. A static scan: the checks are the proof.
 */
export function rootReferences(cwd: string, main: string, source: string): RootReference[] {
  const onMain = trackedFiles(cwd, main);
  const onSource = trackedFiles(cwd, source);
  const known = (path: string) => onMain.has(path) || onSource.has(path);
  const found = new Map<string, RootReference>();
  const queue: Array<{ file: string; runtime: boolean; text: string }> = [];
  for (const file of onSource)
    if (file.startsWith(`${CONTROL_PLANE}/`) && /\.(ts|tsx|js|mjs)$/.test(file))
      queue.push({ file, runtime: !isTestFile(file), text: readBlob(cwd, source, file) ?? '' });
  while (queue.length) {
    const { file, runtime, text } = queue.pop()!;
    for (const match of text.matchAll(RELATIVE_LITERAL)) {
      const literal = match[2]!;
      if (literal.includes('${')) continue;
      const joined = posix.normalize(posix.join(posix.dirname(file), literal)).replace(/\/$/, '');
      if (joined.startsWith('..') || joined.startsWith(`${CONTROL_PLANE}/`) || joined === CONTROL_PLANE) continue;
      const path = [joined, `${joined}.ts`, `${joined}/index.ts`].find(known);
      if (!path) continue;
      const existing = found.get(path);
      if (existing && (existing.runtime || !runtime)) continue;
      const mainObject = object(cwd, main, path);
      const sourceObject = object(cwd, source, path);
      const status =
        mainObject === sourceObject
          ? 'same'
          : mainObject === undefined
            ? 'dev only'
            : sourceObject === undefined
              ? 'main only'
              : 'differs';
      found.set(path, { path, runtime, status, from: file });
      if (/\.(ts|tsx)$/.test(path)) queue.push({ file: path, runtime, text: readBlob(cwd, source, path) ?? '' });
    }
  }
  return [...found.values()].sort((a, b) => Number(b.runtime) - Number(a.runtime) || a.path.localeCompare(b.path));
}

/** Main's root configuration and scripts that name tools/goal paths the synced tree no longer has. */
export function missingControlPlanePaths(cwd: string, main: string, candidate: string): string[] {
  const files = [...trackedFiles(cwd, main)].filter(
    (path) =>
      /^(bunfig\.toml|package\.json|tsconfig[\w.-]*\.json|\.oxlintrc\.json|\.oxfmtrc\.json)$/.test(path) ||
      (/^scripts\/[^/]+\.ts$/.test(path) && !path.endsWith('.test.ts')),
  );
  const missing: string[] = [];
  for (const file of files) {
    const text = readBlob(cwd, main, file) ?? '';
    for (const match of text.matchAll(/(['"`])((?:\.{1,2}\/)*tools\/goal\/[^'"`\s*]*)\1/g)) {
      const literal = match[2]!;
      const path = literal.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(file), literal))
        : posix.normalize(literal);
      if (path.startsWith(`${CONTROL_PLANE}/`) && !object(cwd, candidate, path.replace(/\/$/, '')))
        missing.push(`${file} names ${path}`);
    }
  }
  return [...new Set(missing)];
}

// ---------------------------------------------------------------------------------------------------------------
// History

export type HistoryEntry = {
  time: string;
  action: 'sync' | 'rollback';
  main: { previous: string; current: string };
  paths: string[];
  source?: string;
  stabilize?: { previous: string; current: string };
  dev?: { previous: string; current: string };
  restores?: string;
};

export function readHistory(file: string): HistoryEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as HistoryEntry;
      } catch {
        throw new Refusal(`${file} line ${index + 1} is not a history record; fix it before running cp-sync.`);
      }
    });
}

function appendHistory(file: string, entry: HistoryEntry): void {
  assertNotDatabase(file);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { flag: 'a' });
}

/** The newest sync that no later rollback has undone. */
export function rollbackTarget(history: readonly HistoryEntry[]): HistoryEntry | undefined {
  const stack: HistoryEntry[] = [];
  for (const entry of history) {
    if (entry.action === 'sync') stack.push(entry);
    else stack.pop();
  }
  return stack.at(-1);
}

// ---------------------------------------------------------------------------------------------------------------
// Publication

/** Reinstalls dependencies in the main checkout where a synced manifest or lockfile changed. */
async function reinstall(
  checkout: string,
  previous: string,
  next: string,
  paths: readonly string[],
  logs: string,
  print: (line: string) => void,
): Promise<boolean> {
  const directories = new Set(
    changedPaths(checkout, previous, next, paths)
      .filter((path) => /(^|\/)(package\.json|bun\.lock)$/.test(path))
      .map((path) => (path.startsWith(`${CONTROL_PLANE}/`) ? CONTROL_PLANE : '.')),
  );
  let ok = true;
  for (const directory of directories) {
    const step = await runCheck(
      {
        name: `main checkout install (${directory})`,
        argv: ['bun', 'install', '--frozen-lockfile'],
        cwd: directory,
        timeoutMs: scriptPolicy().cpSync.installTimeoutMs,
      },
      checkout,
      join(logs, `main-install-${directory === '.' ? 'root' : 'goal'}.log`),
      print,
    );
    reportStep(step, print);
    ok &&= step.exitCode === 0;
  }
  return ok;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

export type ResidentHealth = {
  /** Mean number of live workers over the window's samples. */
  liveWorkers: number;
  passedGates: number;
  /** Landings merged in the window. */
  landings: number;
  /** A sample saw an undelivered landing request whose task is in the landing state. */
  landingsRequested?: boolean;
};
/** Samples `sampleMs` apart; a single sample is an instant reading with no wait. */
export type ResidentWindow = { samples: number; sampleMs: number };
export type ResidentControl = {
  observe(checkout: string, sampling: ResidentWindow): Promise<ResidentHealth>;
  restart(checkout: string, options?: { install: boolean }): Promise<void>;
};

/** The reading at publication: publication never waits for an observation window. */
const INSTANT: ResidentWindow = { samples: 1, sampleMs: 0 };
/** The window after publication: `residentSamples` readings `residentSampleMs` apart. */
const residentWindow = (): ResidentWindow => ({
  samples: scriptPolicy().cpSync.residentSamples,
  sampleMs: scriptPolicy().cpSync.residentSampleMs,
});

/** Reads worker width and landings from the live database; samples after the first wait `pause` for `sampleMs`. */
export async function observeResident(
  checkout: string,
  sampling: ResidentWindow,
  pause: (milliseconds: number) => Promise<unknown> = (milliseconds) => Bun.sleep(milliseconds),
): Promise<ResidentHealth> {
  const file = join(checkout, '.temp/goal/goal.sqlite');
  const db = new Database(file, { readonly: true });
  const start = new Date().toISOString();
  let workers = 0;
  let landingsRequested = false;
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const hasQueue = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'landing_queue'").get();
    for (let sample = 0; sample < sampling.samples; sample++) {
      if (hasQueue)
        landingsRequested ||= !!db
          .query(`SELECT 1 FROM landing_queue q JOIN worker_tasks t
          ON t.id = q.task AND t.current_attempt = q.attempt
          WHERE q.delivered = 0 AND q.outcome IS NULL AND json_extract(t.body, '$.state') = 'landing' LIMIT 1`)
          .get();
      const rows = db
        .query(`SELECT a.body FROM worker_attempts a JOIN worker_tasks t ON t.id = a.task_id
        AND t.current_attempt = a.attempt WHERE json_extract(a.body, '$.state') = 'running'`)
        .all() as { body: string }[];
      for (const row of rows) {
        const identity = JSON.parse(row.body).process;
        if (!identity || identity.boot !== boot) continue;
        try {
          const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
          const fields = stat
            .slice(stat.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/);
          if (fields[0] !== 'Z' && fields[19] === identity.start && Number(fields[2]) === identity.group) workers++;
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      if (sample + 1 < sampling.samples) await pause(sampling.sampleMs);
    }
    const events = db
      .query(`SELECT body FROM worker_events WHERE kind = 'gate-outcome' AND at >= ? AND at < ?`)
      .all(start, new Date().toISOString()) as { body: string }[];
    const passed = events.map((row) => JSON.parse(row.body)).filter((outcome) => outcome.passed);
    return {
      liveWorkers: workers / sampling.samples,
      landingsRequested,
      passedGates: passed.length,
      landings: passed.filter((outcome) => outcome.stage === 'merge' && outcome.mergedCommit).length,
    };
  } finally {
    db.close();
  }
}

export type ResidentCommand = (argv: string[], checkout: string) => Promise<{ code: number; output: string }>;
export const residentCommand: ResidentCommand = async (argv, checkout) => {
  const env = Object.fromEntries(
    ['HOME', 'USER', 'LOGNAME', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'KERNEL_CHECK_REMOTE'].flatMap(
      (key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
    ),
  );
  const child = Bun.spawn(argv, {
    cwd: checkout,
    env: { ...env, GOAL_MAIN_CHECKOUT: checkout, GOAL_LOCAL_CONFIG: join(checkout, '.temp/goal/local.json') },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: out + err };
};

/** Run only after publication: the newly published main supplies the installer. */
export async function restartResident(
  checkout: string,
  run: ResidentCommand = residentCommand,
  install = false,
): Promise<void> {
  const checked = async (argv: string[]) => {
    const result = await run(argv, checkout);
    if (result.code !== 0 && !(argv.includes('--property=LoadState') && result.output.trim() === 'not-found'))
      throw new Refusal(result.output.trim() || `${argv.join(' ')}: exit ${result.code}`);
    return result.output.trim();
  };
  const loads: string[] = [];
  for (const unit of RESIDENT_CODE_UNITS)
    loads.push(await checked(['systemctl', '--user', 'show', '--property=LoadState', '--value', unit]));
  const legacy = await checked([
    'systemctl',
    '--user',
    'show',
    '--property=LoadState',
    '--value',
    'rezics-goal-supervisor.service',
  ]);
  if (
    install ||
    !existsSync(join(checkout, '.temp/goal/goal.env')) ||
    loads.includes('not-found') ||
    legacy === 'loaded' ||
    existsSync(join(checkout, '.temp/goal/manager-host-supervisor.lease')) ||
    existsSync(join(checkout, '.temp/goal/manager-host-liveness.json'))
  )
    await checked([process.execPath, 'tools/goal/src/cli.ts', 'service', 'install']);
  // Host Type=notify waits for READY=1; KillMode=process keeps worker scopes. The verifier restarts on its own unit.
  const publishedAtSec = Math.floor(Date.now() / 1000);
  for (const unit of RESIDENT_CODE_UNITS) {
    const restarted = await run(['systemctl', '--user', 'restart', unit], checkout);
    if (restarted.code !== 0)
      throw new Refusal(`${unit} failed to restart: ${restarted.output.trim() || `exit ${restarted.code}`}`);
    const shown = await run(
      ['systemctl', '--user', 'show', unit, '--property=ActiveState,ExecMainStartTimestamp', '--timestamp=unix'],
      checkout,
    );
    const startedAtSec = Number(/^ExecMainStartTimestamp=@(\d+)$/m.exec(shown.output)?.[1]);
    if (shown.code !== 0 || !/^ActiveState=active$/m.test(shown.output))
      throw new Refusal(`${unit} did not become ready.`);
    if (!Number.isSafeInteger(startedAtSec) || startedAtSec < publishedAtSec)
      throw new Refusal(`${unit} did not start after publication.`);
  }
}

/**
 * A release rolls back only on a real signal: live workers fell by more than half, or landings that were running before
 * publication merged none in the window. Lower counts within half, and quiet windows, are normal.
 */
export function residentRegression(before: ResidentHealth, after: ResidentHealth): boolean {
  const workersFell = before.liveWorkers > 0 && after.liveWorkers < before.liveWorkers / 2;
  const landingsStopped = before.landingsRequested === true && after.landings === 0;
  return workersFell || landingsStopped;
}
const residentControl: ResidentControl = {
  observe: (checkout, sampling) => observeResident(checkout, sampling),
  restart: (checkout, options) => restartResident(checkout, residentCommand, options?.install),
};

export type Options = {
  policy?: ControlPolicy;
  dryRun?: boolean;
  rollback?: boolean;
  resident?: ResidentControl;
  includes?: string[];
  keepWorktree?: boolean;
  /** Also run the suite, gated on no failures beyond unmodified main's. */
  full?: boolean;
  /** Run main's suite again instead of reusing its cached failing tests. */
  freshBaseline?: boolean;
  cwd?: string;
  checks?: readonly Check[];
  worktreeRoot?: string;
  print?: (line: string) => void;
  now?: () => Date;
};

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One publishing cp-sync at a time; a lock whose owner died is taken over. */
function lock(directory: string): () => void {
  mkdirSync(dirname(directory), { recursive: true });
  try {
    mkdirSync(directory);
  } catch {
    let pid = 0;
    try {
      pid = Number(readFileSync(join(directory, 'pid'), 'utf8').trim());
    } catch {
      throw new Refusal(`Another cp-sync is starting (${directory}); run again shortly.`);
    }
    if (processAlive(pid)) throw new Refusal(`Another cp-sync (pid ${pid}) is running.`);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory);
  }
  writeFileSync(join(directory, 'pid'), `${process.pid}\n`);
  return () => rmSync(directory, { recursive: true, force: true });
}

function validateIncludes(cwd: string, includes: readonly string[], main: string, source: string): string[] {
  return includes.map((raw) => {
    const path = posix.normalize(raw).replace(/\/$/, '');
    if (
      raw.startsWith('/') ||
      path.startsWith('..') ||
      path === '.' ||
      path === CONTROL_PLANE ||
      path.startsWith(`${CONTROL_PLANE}/`) ||
      /^(\.git|\.temp)(\/|$)/.test(path)
    )
      throw new Refusal(`--include takes a repository path outside ${CONTROL_PLANE}; got ${raw}.`);
    if (!object(cwd, main, path) && !object(cwd, source, path))
      throw new Refusal(`--include ${raw} names nothing on ${MAIN} or ${DEV}.`);
    return path;
  });
}

export async function sync(options: Options = {}): Promise<number> {
  return withScriptPolicy(
    options.policy ?? readScriptPolicy(findMainCheckout(options.cwd ?? process.cwd())),
    async () => {
      const print = options.print ?? ((line: string) => console.log(redact(line)));
      const now = (options.now ?? (() => new Date()))();
      const checkout = findMainCheckout(options.cwd ?? process.cwd());
      const refs = refTransactionContext(checkout);
      const state = join(checkout, '.temp/goal');
      const main = head(checkout, MAIN)!;
      const source = head(checkout, DEV);
      if (!source) throw new Refusal(`Branch ${DEV} does not exist.`);
      const includes = validateIncludes(checkout, options.includes ?? [], main, source);
      const paths = [CONTROL_PLANE, ...includes];
      print(
        `cp-sync: ${options.dryRun ? 'dry run: ' : ''}${DEV} ${short(source)} -> ${MAIN} ${short(main)} (${checkout})`,
      );
      if (!isAncestor(checkout, main, source))
        throw new Refusal(`${MAIN} ${short(main)} has commits ${DEV} lacks; syncing would drop them.`);
      if (paths.every((path) => object(checkout, main, path) === object(checkout, source, path))) {
        print(`cp-sync: ${MAIN} already has ${DEV}'s ${paths.join(', ')}; nothing to do.`);
        return 0;
      }
      let ready = true;
      try {
        assertCheckoutReady(checkout, main, paths);
      } catch (error) {
        if (!(error instanceof Refusal) || !options.dryRun) throw error;
        print(`cp-sync: a real run would refuse: ${error.message}`);
        ready = false;
      }

      const references = rootReferences(checkout, main, source);
      const differing = references.filter((reference) => reference.status !== 'same');
      print(
        `cp-sync: ${DEV}'s ${CONTROL_PLANE} reaches ${references.length} root files; ${differing.length} differ from ${MAIN}:`,
      );
      for (const reference of differing)
        print(
          `  ${reference.runtime ? 'runtime' : 'test   '}  ${reference.status.padEnd(9)} ${reference.path}${includes.some((path) => reference.path === path || reference.path.startsWith(`${path}/`)) ? '  (included)' : ''}  <- ${reference.from}`,
        );
      if (differing.length)
        print(`cp-sync: checks use ${MAIN}'s copies; pass --include <path> to sync one from ${DEV} as well.`);
      for (const path of ['bun.lock', 'package.json'])
        if ((readBlob(checkout, main, path) ?? '').includes('tools/goal'))
          print(`cp-sync: root ${path} names tools/goal; check whether it needs ${DEV}'s entries.`);

      const release = options.dryRun ? () => {} : lock(join(state, 'cp-sync.lock'));
      const id = `${stamp(now)}-${short(source)}`;
      const logs = join(state, 'cp-sync', id);
      const worktree = join(options.worktreeRoot ?? join(dirname(checkout), 'worktrees'), `cp-sync-${id}`);
      const checks = options.checks ?? syncChecks(checkout, options.full === true);
      // Main's failing tests come from its installs and suite alone; its smoke would only exercise main's own CLI.
      const baselineChecks = checks.filter((check) => check.kind === 'prepare' || check.kind === 'suite');
      mkdirSync(logs, { recursive: true });
      const created: string[] = [];
      const addWorktree = (path: string, commit: string) => {
        mkdirSync(dirname(path), { recursive: true });
        git(checkout, 'worktree', 'add', '--detach', '--quiet', path, commit);
        created.push(path);
      };
      const removeWorktree = (path: string) => {
        const index = created.indexOf(path);
        if (index < 0) return;
        created.splice(index, 1);
        if (options.keepWorktree) return print(`cp-sync: kept ${path}`);
        const stopped = stopProcessesIn(path);
        if (stopped) print(`cp-sync: stopped ${stopped} leftover processes in ${path}`);
        const removed = run(checkout, ['worktree', 'remove', '--force', '--force', path]);
        if (removed.status !== 0) print(`cp-sync: could not remove ${path}: ${redact(removed.stderr.trim())}`);
      };
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        stopOwnedCheck();
        for (const path of [...created]) removeWorktree(path);
        release();
      };
      // Main's own failing tests, from the same checks on an unmodified worktree of main, cached per main commit.
      const mainBaseline = async (): Promise<Baseline | undefined> => {
        const file = baselineFile(state, main, baselineChecks);
        const cached = options.freshBaseline ? undefined : readBaseline(file, main, baselineChecks);
        if (cached) {
          print(`cp-sync: ${MAIN} ${short(main)} has ${cached.failures.length} failing tests (cached ${cached.time})`);
          return cached;
        }
        print(`cp-sync: running the same checks on unmodified ${MAIN} ${short(main)} to learn its failing tests`);
        const path = `${worktree}-main`;
        addWorktree(path, main);
        try {
          const steps = await runChecks(baselineChecks, path, logs, 'main ', true, print);
          const suite = steps.find((step) => step.kind === 'suite');
          if (!suite) return undefined;
          const summary = summarizeTests(readFileSync(suite.log, 'utf8'));
          if (suite.exitCode !== 0 && !comparable(suite, summary)) return undefined;
          const baseline: Baseline = {
            version: 1,
            main,
            checks: checksKey(baselineChecks),
            time: new Date().toISOString(),
            ran: summary.ran ?? '',
            failures: suite.exitCode === 0 ? [] : summary.failures,
          };
          writeBaseline(file, baseline);
          return baseline;
        } finally {
          removeWorktree(path);
        }
      };
      let publicationStarted = false;
      let interrupted = false;
      const interrupt = (signal: NodeJS.Signals) => {
        if (publicationStarted) {
          interrupted = true;
          stopOwnedCheck();
          print(`cp-sync: ${signal}; completing host recovery before exit.`);
          return;
        }
        print(`cp-sync: ${signal}; no ref moved by this step`);
        cleanup();
        process.exit(128 + (constants.signals[signal] ?? 0));
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      try {
        addWorktree(worktree, main);
        git(worktree, 'checkout', '--no-overlay', source, '--', ...paths);
        const tree = git(worktree, 'write-tree');
        const unexpected = git(worktree, 'diff', '--name-only', main, tree)
          .split('\n')
          .filter((path) => path && !paths.some((root) => path === root || path.startsWith(`${root}/`)));
        if (unexpected.length || paths.some((path) => object(worktree, tree, path) !== object(worktree, source, path)))
          throw new Error(`The candidate tree does not equal ${MAIN} plus ${DEV}'s ${paths.join(', ')}.`);
        print(`cp-sync: changes (${MAIN} ${short(main)} -> candidate):`);
        for (const line of git(worktree, 'diff', `--stat=${scriptPolicy().cpSync.statColumns}`, main, tree).split('\n'))
          print(`  ${line}`);
        for (const missing of missingControlPlanePaths(checkout, main, tree))
          print(`cp-sync: WARNING: ${missing}, which the candidate lacks`);

        // The checks run on the committed candidate, as the main-release proof does, so tests that read the checkout's
        // HEAD see it. The commit stays unreachable on this detached worktree unless every step passes.
        git(worktree, 'commit', '--quiet', '-m', `control-plane: sync tools/goal from dev ${short(source)}`);
        const commit = git(worktree, 'rev-parse', 'HEAD');
        if (
          git(worktree, 'rev-parse', `${commit}^{tree}`) !== tree ||
          git(worktree, 'rev-parse', `${commit}^`) !== main
        )
          throw new Error('The sync commit does not hold the candidate tree.');
        if (checks.some((check) => check.kind === 'smoke')) {
          const copied = copyDatabase(join(state, 'goal.sqlite'), join(worktree, SMOKE_STATE));
          print(
            `cp-sync: smoke state: ${copied ? 'read-only copy of the live Goal database' : 'empty (no live database)'}`,
          );
        }

        // A dry run reports the suite even after a failed type check; a real run stops at the first failed step.
        const steps = await runChecks(checks, worktree, logs, '', options.dryRun === true, print);
        const verdict = await gate(checks, steps, worktree, logs, mainBaseline, print);
        if (verdict.known.length) {
          print(`cp-sync: ${verdict.known.length} failing tests also fail on unmodified ${MAIN}:`);
          for (const name of verdict.known) print(`  (fail on ${MAIN} too) ${name}`);
        }
        for (const name of verdict.flaky) print(`  (failed, then passed on rerun) ${name}`);
        for (const name of verdict.added) print(`  (NEW failure) ${name}`);
        writeFileSync(
          join(logs, 'results.json'),
          `${JSON.stringify({ main, source, commit, paths, steps, gate: verdict }, null, 2)}\n`,
        );
        if (!verdict.passed) {
          print(`cp-sync: refused: ${verdict.reason}; no ref moved. Logs: ${logs}`);
          return 1;
        }
        const touched = git(worktree, 'status', '--porcelain', '--untracked-files=no');
        if (touched || git(worktree, 'rev-parse', 'HEAD') !== commit)
          throw new Refusal(
            `The checks changed the candidate checkout:\n${touched.split('\n').slice(0, scriptPolicy().cpSync.changedPaths).join('\n')}`,
          );
        print(`cp-sync: checks passed (${verdict.reason}); sync commit ${short(commit)}`);

        if (options.dryRun) {
          const preview = planCpSyncRefs(refs, 'sync', main, commit, paths, source);
          for (const update of preview.updates)
            print(`cp-sync: would move ${update.ref} ${short(update.previous)} -> ${short(update.next)}`);
          for (const warning of preview.warnings) print(`cp-sync: ${warning}`);
          print(`cp-sync: dry run; no ref or checkout moved.${ready ? '' : ' A real run would refuse (see above).'}`);
          return ready ? 0 : 1;
        }

        const resident = options.resident ?? residentControl;
        const before = await resident.observe(checkout, INSTANT);
        publicationStarted = true;
        const published = publishCpSyncRefs(refs, 'sync', main, commit, paths, source, print);
        try {
          const ref = (name: string) => published.updates.find((update) => update.ref === `refs/heads/${name}`);
          const pair = (update: RefUpdate | undefined) =>
            update ? { previous: update.previous, current: update.next } : undefined;
          const stabilizeMove = pair(ref(STABILIZE));
          const devMove = pair(ref(DEV));
          appendHistory(join(state, 'cp-sync-history.log'), {
            time: now.toISOString(),
            action: 'sync',
            main: { previous: main, current: commit },
            paths,
            source,
            ...(stabilizeMove ? { stabilize: stabilizeMove } : {}),
            ...(devMove ? { dev: devMove } : {}),
          });
          for (const update of published.updates)
            print(`cp-sync: moved ${update.ref} ${short(update.previous)} -> ${short(update.next)}`);
          for (const warning of published.warnings) print(`cp-sync: ${warning}`);
          // The published commit is the one just checked, so its suite failures are the next sync's baseline.
          if (checks.some((check) => check.kind === 'suite'))
            writeBaseline(baselineFile(state, commit, baselineChecks), {
              version: 1,
              main: commit,
              checks: checksKey(baselineChecks),
              time: new Date().toISOString(),
              ran: verdict.ran,
              failures: verdict.failures,
            });
          if (!(await reinstall(checkout, main, commit, paths, logs, print)))
            throw new Refusal('The main checkout install failed.');
          await resident.restart(checkout);
          if (interrupted) throw new Refusal('Publication interrupted.');
          print('cp-sync: observing resident workers and gate outcomes for three minutes after publication.');
          const after = await resident.observe(checkout, residentWindow());
          print(`cp-sync: resident before ${JSON.stringify(before)}; after ${JSON.stringify(after)}`);
          if (residentRegression(before, after))
            throw new Refusal(
              'Resident lost more than half of its live workers, or landings running before publication merged none.',
            );
        } catch (error) {
          print(`cp-sync: ${error instanceof Error ? error.message : String(error)}; rolling back.`);
          // Release this sync's lock before invoking the ordinary forward-only rollback transaction.
          cleanup();
          try {
            await rollback({ ...options, resident });
          } catch (recoveryError) {
            // Rollback can refuse before touching main (for example a ref race). Its current code still needs a host.
            await resident.restart(checkout);
            print(`cp-sync: rollback refused; host restarted on current main: ${String(recoveryError)}`);
          }
          return 1;
        }
        print(
          `cp-sync: ${MAIN} now runs ${DEV}'s ${CONTROL_PLANE} from ${short(source)}; previous ${MAIN} ${short(main)}.`,
        );
        return 0;
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
        cleanup();
      }
    },
  );
}

export async function rollback(options: Options = {}): Promise<number> {
  return withScriptPolicy(
    options.policy ?? readScriptPolicy(findMainCheckout(options.cwd ?? process.cwd())),
    async () => {
      const print = options.print ?? ((line: string) => console.log(redact(line)));
      const now = (options.now ?? (() => new Date()))();
      const checkout = findMainCheckout(options.cwd ?? process.cwd());
      const refs = refTransactionContext(checkout);
      const state = join(checkout, '.temp/goal');
      const historyFile = join(state, 'cp-sync-history.log');
      const history = readHistory(historyFile);
      const current = head(checkout, MAIN)!;
      const last = history.at(-1);
      if (!last) throw new Refusal(`No cp-sync history in ${historyFile}; nothing to roll back.`);
      if (last.main.current !== current)
        throw new Refusal(
          `${MAIN} moved since the last cp-sync (${short(last.main.current)} -> ${short(current)}); refusing to roll back.`,
        );
      const target = rollbackTarget(history);
      if (!target) throw new Refusal('Every recorded sync is already rolled back.');
      const { paths } = target;
      if (changedPaths(checkout, target.main.current, current, paths).length)
        throw new Refusal(`${MAIN}'s ${paths.join(', ')} no longer match the sync ${short(target.main.current)}.`);
      const tree = replacePaths(checkout, current, target.main.previous, paths);
      print(
        `cp-sync: ${options.dryRun ? 'dry run: ' : ''}roll back ${paths.join(', ')} to ${MAIN} ${short(target.main.previous)} (now ${short(current)})`,
      );
      for (const line of git(checkout, 'diff', `--stat=${scriptPolicy().cpSync.statColumns}`, current, tree).split(
        '\n',
      ))
        print(`  ${line}`);
      const release = options.dryRun ? () => {} : lock(join(state, 'cp-sync.lock'));
      const resident = options.resident ?? residentControl;
      let moved = false;
      let rollbackHead: string | undefined;
      let interrupted = false;
      const interrupt = (signal: NodeJS.Signals) => {
        interrupted = true;
        stopOwnedCheck();
        print(`cp-sync: ${signal}; completing rollback host recovery before exit.`);
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      try {
        // Main only moves forward (the repository's reference-transaction hook), so the rollback is a new commit
        // holding the earlier tree.
        const commit = commitTree(
          checkout,
          tree,
          [current],
          `control-plane: roll back tools/goal to ${short(target.main.previous)}`,
        );
        if (options.dryRun) {
          assertCheckoutReady(checkout, current, paths);
          for (const update of planCpSyncRefs(refs, 'rollback', current, commit, paths).updates)
            print(`cp-sync: would move ${update.ref} ${short(update.previous)} -> ${short(update.next)}`);
          print('cp-sync: dry run; no ref or checkout moved.');
          return 0;
        }
        const published = publishCpSyncRefs(refs, 'rollback', current, commit, paths, undefined, print);
        moved = true;
        rollbackHead = commit;
        appendHistory(historyFile, {
          time: now.toISOString(),
          action: 'rollback',
          main: { previous: current, current: commit },
          paths,
          restores: target.main.previous,
        });
        for (const update of published.updates)
          print(`cp-sync: moved ${update.ref} ${short(update.previous)} -> ${short(update.next)}`);
        for (const warning of published.warnings) print(`cp-sync: ${warning}`);
        const logs = join(state, 'cp-sync', `${stamp(now)}-rollback`);
        mkdirSync(logs, { recursive: true });
        if (!(await reinstall(checkout, current, commit, paths, logs, print)))
          throw new Refusal('The rolled-back checkout install failed.');
        await resident.restart(checkout);
        if (interrupted) throw new Refusal('Rollback interrupted.');
        print(`cp-sync: ${MAIN} runs the ${CONTROL_PLANE} of ${short(target.main.previous)} again.`);
        return 0;
      } catch (error) {
        if (!moved) throw error;
        // Older code may lack the systemd CLI entirely. Put the published code back in a forward commit before
        // restarting it; never exit with a new host executing against a rolled-back working tree.
        print(`cp-sync: rollback host failed (${String(error)}); restoring published code and host.`);
        const failed = head(checkout, MAIN)!;
        if (failed !== rollbackHead) {
          await resident.restart(checkout);
          print('cp-sync: main advanced during rollback; host restarted on its current code.');
          return 1;
        }
        const restored = commitTree(
          checkout,
          replacePaths(checkout, failed, current, paths),
          [failed],
          `control-plane: restore running host code ${short(current)}`,
        );
        publishCpSyncRefs(refs, 'rollback', failed, restored, paths, undefined, print);
        const logs = join(state, 'cp-sync', `${stamp(now)}-recovery`);
        try {
          mkdirSync(logs, { recursive: true });
          await reinstall(checkout, failed, restored, paths, logs, print);
        } finally {
          // An older installer may also have replaced the unit files. Restore them with the matching code.
          await resident.restart(checkout, { install: true });
        }
        appendHistory(historyFile, {
          time: now.toISOString(),
          action: 'sync',
          paths,
          main: { previous: failed, current: restored },
          source: current,
        });
        print('cp-sync: retained the published code with a running host; rollback failed.');
        return 1;
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
        release();
      }
    },
  );
}

const USAGE = `Usage: bun tools/goal/scripts/cp-sync.ts [--dry-run] [--rollback] [--include <path>]... [--keep-worktree]
       [--full [--fresh-baseline]]

Checks dev's tools/goal on a temporary worktree of main (installs, type check, the candidate loaders against the live
local settings and configured routing table, a CLI smoke against a copy of the live Goal state), then publishes it to
main, stabilize and dev with one compare-and-swap and updates the main checkout's files. --full also runs the suite,
which may only fail where unmodified main fails too; --fresh-baseline reruns main's suite instead of reusing its
cached failures. --rollback restores the tools/goal of the main commit before the newest sync. --include also syncs a
root path from dev.`;

export function parseArguments(args: readonly string[]): Options | undefined {
  const options: Options & { includes: string[] } = { includes: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--rollback') options.rollback = true;
    else if (arg === '--keep-worktree') options.keepWorktree = true;
    else if (arg === '--fresh-baseline') options.freshBaseline = true;
    else if (arg === '--full') options.full = true;
    else if (arg === '--include' && args[index + 1]) options.includes.push(args[++index]!);
    else return undefined;
  }
  if (options.rollback && options.includes.length) return undefined;
  return options;
}

if (import.meta.main) {
  const options = parseArguments(Bun.argv.slice(2));
  if (!options) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    process.exitCode = await (options.rollback ? rollback(options) : sync(options));
  } catch (error) {
    console.error(`cp-sync: ${redact(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
}
