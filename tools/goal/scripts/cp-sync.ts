#!/usr/bin/env bun
/**
 * cp-sync makes dev's control plane live on main without the main-release proof. It checks dev's `tools/goal` on a
 * temporary worktree of main, then publishes it to main, stabilize and dev in one compare-and-swap transaction and
 * updates the main checkout's working tree. See "Control plane on dev: cp-sync" in tools/goal/README.md.
 *
 * The script imports nothing from tools/goal/src, so it runs from any checkout of the repository, including before
 * main has it.
 */
import { Database } from 'bun:sqlite';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { dirname, join, posix, resolve } from 'node:path';

export const CONTROL_PLANE = 'tools/goal';
const MAIN = 'main';
const DEV = 'dev';
const STABILIZE = 'stabilize';
const MINUTE = 60_000;
const ZERO = '0'.repeat(40);

export type Check = {
  name: string;
  argv: readonly string[];
  cwd?: string;
  timeoutMs: number;
  /**
   * `prepare`: later steps need it, so its failure ends even a dry run. `smoke`: runs against a scratch copy of the
   * live Goal database. `suite`: gated against main's failures.
   */
  kind?: 'prepare' | 'typecheck' | 'smoke' | 'suite';
  /** The suite restricted to some test files, for the one rerun of failures main does not have. */
  rerun?: (files: readonly string[]) => readonly string[];
  /** Variables set for this check only, after the child environment is cleaned; given the worktree it runs in. */
  env?: (worktree: string) => Record<string, string>;
};

/** Where a smoke check's copy of the live Goal state lives, inside the temporary worktree. */
export const SMOKE_STATE = '.temp/cp-sync-state';

/**
 * The candidate loaders parse the live local settings and the routing table they name. `checkSettings` is strict and
 * writes nothing; this check does not copy state, launch workers or signal processes.
 */
export function configSmoke(checkout: string): Check {
  return {
    name: 'config smoke',
    argv: ['bun', 'tools/goal/scripts/cp-config-smoke.ts'],
    timeoutMs: MINUTE,
    kind: 'smoke',
    env: () => ({
      GOAL_MAIN_CHECKOUT: checkout,
      GOAL_LOCAL_CONFIG: join(checkout, '.temp/goal/local.json'),
    }),
  };
}

/**
 * The candidate CLI loads the live settings and a copy of the live database, applying its migrations to the copy.
 * GOAL_MANAGER keeps orphan recovery from handing a train to a detached process, which would act on live refs.
 */
export function cliSmoke(checkout: string): Check {
  return {
    name: 'cli smoke',
    argv: ['bun', 'tools/goal/src/cli.ts', 'status'],
    timeoutMs: 5 * MINUTE,
    kind: 'smoke',
    env: (worktree) => ({
      GOAL_MAIN_CHECKOUT: checkout,
      GOAL_LOCAL_CONFIG: join(checkout, '.temp/goal/local.json'),
      GOAL_STATE_DIRECTORY: join(worktree, SMOKE_STATE),
      GOAL_MANAGER: 'cp-sync-smoke',
    }),
  };
}

const SUITE = ['bun', 'test', '--timeout', '30000'];
// The install, typing and suite steps of the main-release proof (CONTROL_PLANE_CHECKS in src/merge-train.ts).
export const PROOF_CHECKS: readonly Check[] = [
  { name: 'root install', argv: ['bun', 'install', '--frozen-lockfile'], timeoutMs: 10 * MINUTE, kind: 'prepare' },
  {
    name: 'tools/goal install',
    argv: ['bun', 'install', '--frozen-lockfile', '--cwd', 'tools/goal'],
    timeoutMs: 10 * MINUTE,
    kind: 'prepare',
  },
  {
    name: 'type check',
    argv: ['bun', 'run', '--cwd', 'tools/goal', 'typecheck'],
    timeoutMs: 15 * MINUTE,
    kind: 'typecheck',
  },
  {
    name: 'test suite',
    argv: [...SUITE, 'tools/goal/src'],
    timeoutMs: 30 * MINUTE,
    kind: 'suite',
    rerun: (files) => [...SUITE, ...files],
  },
];

/** Installs, the type check, live config/routing parse and the CLI smoke; `full` adds the suite. */
export function syncChecks(checkout: string, full = false): Check[] {
  const suite = PROOF_CHECKS.filter((check) => check.kind === 'suite');
  return [
    ...PROOF_CHECKS.filter((check) => check.kind !== 'suite'),
    configSmoke(checkout),
    cliSmoke(checkout),
    ...(full ? suite : []),
  ];
}

/** Copies the live Goal database for a smoke check without writing it: a read-only connection's VACUUM INTO. */
function copyDatabase(source: string, directory: string): boolean {
  mkdirSync(directory, { recursive: true });
  if (!existsSync(source)) return false;
  const target = join(directory, 'goal.sqlite');
  if (resolve(target) === resolve(source)) throw new Error('cp-sync never writes the Goal database');
  const db = new Database(source, { readonly: true });
  try {
    db.run('VACUUM INTO ?', [target]);
  } finally {
    db.close();
  }
  return true;
}

export class Refusal extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Environment and output hygiene

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_KEY|CREDENTIAL|COOKIE|(^|_)AUTH(_|$)/i;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];
// Variables that point Git at a particular repository; cp-sync names every repository explicitly.
const GIT_LOCATION = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_NAMESPACE',
];

/** Replaces secret-named environment values and common credential shapes. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = text;
  const values = Object.entries(env)
    .filter(([key, value]) => SECRET_NAME.test(key) && value !== undefined && value.length >= 8)
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  for (const value of values) result = result.split(value).join('[redacted]');
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[redacted]');
  return result;
}

/**
 * Children never see the control plane's identity, store or session, nor secret-named variables: the suite and the
 * installs need none of them, and a test that spawns the CLI must not act on the live Goal.
 */
export function childEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(GOAL_|CLAUDE|CODEX_)/.test(key) || GIT_LOCATION.includes(key) || SECRET_NAME.test(key)) continue;
    result[key] = value;
  }
  return result;
}

function assertNotDatabase(path: string): void {
  if (/goal\.sqlite/.test(path)) throw new Error(`cp-sync never writes the Goal database (${path})`);
}

// ---------------------------------------------------------------------------------------------------------------
// Git

type Result = { status: number; stdout: string; stderr: string };

function run(cwd: string, args: readonly string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Result {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...(options.input === undefined ? {} : { input: options.input }),
    env: { ...childEnvironment(), ...options.env },
    maxBuffer: 256 * 1024 * 1024,
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

type RefUpdate = { ref: string; previous: string; next: string };

function transaction(cwd: string, updates: readonly RefUpdate[]): Result {
  const input = updates.map((update) => `update ${update.ref} ${update.next} ${update.previous}\n`).join('');
  return run(cwd, ['update-ref', '-m', 'cp-sync', '--stdin'], { input });
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
        .slice(0, 20)
        .map((line) => `  ${line}`)
        .join('\n')}${dirty.length > 20 ? `\n  ... ${dirty.length - 20} more` : ''}`,
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

export type StepResult = {
  name: string;
  kind: Check['kind'];
  command: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  log: string;
};

let activeChild: ChildProcess | undefined;

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** Runs one check in its own process group, writing redacted output to `log`, bounded by the check's time box. */
export async function runCheck(
  check: Check,
  cwd: string,
  log: string,
  print: (line: string) => void,
): Promise<StepResult> {
  assertNotDatabase(log);
  const command = check.argv.join(' ');
  const directory = check.cwd ? join(cwd, check.cwd) : cwd;
  writeFileSync(log, `$ ${command} (cwd: ${directory})\n`);
  const started = Date.now();
  const child = spawn(check.argv[0]!, check.argv.slice(1), {
    cwd: directory,
    env: { ...childEnvironment(), ...check.env?.(cwd) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChild = child;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      pending += chunk;
      const end = pending.lastIndexOf('\n');
      if (end < 0) return;
      appendFileSync(log, redact(pending.slice(0, end + 1)));
      pending = pending.slice(end + 1);
    });
    stream?.on('end', () => {
      if (pending) appendFileSync(log, redact(pending));
      pending = '';
    });
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    print(`cp-sync: ${check.name} exceeded ${Math.round(check.timeoutMs / MINUTE)} min; stopping it`);
    killGroup(child.pid, 'SIGTERM');
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), 15_000).unref();
  }, check.timeoutMs);
  const heartbeat = setInterval(
    () => print(`cp-sync: ${check.name} running (${Math.round((Date.now() - started) / MINUTE)} min)`),
    2 * MINUTE,
  );
  const exitCode = await new Promise<number>((done) => {
    child.on('error', (error) => {
      appendFileSync(log, `${redact(error.message)}\n`);
      done(127);
    });
    child.on('exit', (code, signal) => {
      // Output pipes can stay open in leftover group members; give them a moment, then stop the group.
      const finish = () => done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 1));
      const grace = setTimeout(finish, 5_000);
      child.on('close', () => {
        clearTimeout(grace);
        finish();
      });
    });
  });
  clearTimeout(timeout);
  clearInterval(heartbeat);
  killGroup(child.pid, 'SIGTERM');
  activeChild = undefined;
  return { name: check.name, kind: check.kind, command, exitCode, durationMs: Date.now() - started, timedOut, log };
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

/** `failures` are `<test file> > <test name>`; bun's closing recap of failures is not counted twice. */
export type TestSummary = { pass?: number; fail?: number; ran?: string; failures: string[] };

export function summarizeTests(output: string): TestSummary {
  const failures = new Set<string>();
  let file = '?';
  for (const line of output.split('\n')) {
    if (/^\d+ tests? failed:$/.test(line)) break;
    const header = line.match(/^(\S.*\.test\.[cm]?[jt]sx?):$/);
    if (header) file = header[1]!;
    const failed = line.match(/^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?$/);
    if (failed) failures.add(`${file} > ${failed[1]}`);
  }
  const pass = output.match(/^\s*(\d+) pass$/m)?.[1];
  const fail = output.match(/^\s*(\d+) fail$/m)?.[1];
  const ran = output.match(/^(Ran \d+ tests? across \d+ files?\. \[[^\]]+\])$/m)?.[1];
  return {
    failures: [...failures],
    ...(pass === undefined ? {} : { pass: Number(pass) }),
    ...(fail === undefined ? {} : { fail: Number(fail) }),
    ...(ran === undefined ? {} : { ran }),
  };
}

/** A suite run whose failures can be compared: it finished, and every failure it counted is named. */
function comparable(step: StepResult, summary: TestSummary): boolean {
  return (
    !step.timedOut &&
    summary.ran !== undefined &&
    (summary.fail ?? 0) === summary.failures.length &&
    step.exitCode < 128
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function reportStep(step: StepResult, print: (line: string) => void): void {
  const verdict = step.timedOut ? 'TIMED OUT' : step.exitCode === 0 ? 'ok' : 'FAILED';
  print(`cp-sync: ${step.name}: exit ${step.exitCode}, ${seconds(step.durationMs)} ${verdict} (log ${step.log})`);
  const output = readFileSync(step.log, 'utf8');
  if (step.kind === 'suite') {
    const summary = summarizeTests(output);
    print(`  ${summary.ran ?? 'no test summary'}: ${summary.pass ?? '?'} pass, ${summary.fail ?? '?'} fail`);
  } else if (step.exitCode !== 0) {
    // Compiler diagnostics lead; install failures end with their cause.
    const lines = output.trimEnd().split('\n').slice(1);
    for (const line of step.kind === 'typecheck' ? lines.slice(0, 40) : lines.slice(-30)) print(`  | ${line}`);
  }
}

/** Runs checks in order; a failed preparation always ends the run, and other failures end it unless `keepGoing`. */
async function runChecks(
  checks: readonly Check[],
  worktree: string,
  logs: string,
  prefix: string,
  keepGoing: boolean,
  print: (line: string) => void,
): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  for (const check of checks) {
    print(
      `cp-sync: ${prefix}${check.name}: ${check.argv.join(' ')} (limit ${Math.round(check.timeoutMs / MINUTE)} min)`,
    );
    const log = join(logs, `${prefix}${check.name}`.replace(/[^a-z0-9]+/gi, '-').replace(/-$/, '') + '.log');
    const step = await runCheck(check, worktree, log, print);
    steps.push(step);
    reportStep(step, print);
    if (step.exitCode !== 0 && (check.kind === 'prepare' || !keepGoing)) break;
  }
  return steps;
}

export type Gate = {
  passed: boolean;
  reason: string;
  ran: string;
  /** Failures of a complete candidate suite run, minus those a rerun cleared. */
  failures: string[];
  known: string[];
  added: string[];
  flaky: string[];
};

/**
 * Every preparation and the type check must pass. The suite passes when it exits 0, or when it ran to completion and
 * every failing test also fails on main: the suite does not pass on an unmodified fresh checkout. New failures get one
 * rerun of their files, and those that pass then are reported as flaky rather than refused.
 */
async function gate(
  checks: readonly Check[],
  steps: readonly StepResult[],
  worktree: string,
  logs: string,
  baseline: () => Promise<Baseline | undefined>,
  print: (line: string) => void,
): Promise<Gate> {
  const empty = { ran: '', failures: [], known: [], added: [], flaky: [] };
  for (const check of checks) {
    const step = steps.find((candidate) => candidate.name === check.name);
    if (!step) return { passed: false, reason: `${check.name} did not run`, ...empty };
    if (check.kind !== 'suite' && step.exitCode !== 0)
      return { passed: false, reason: `${check.name} exited ${step.exitCode}`, ...empty };
  }
  const suiteCheck = checks.find((check) => check.kind === 'suite');
  const suite = steps.find((step) => step.kind === 'suite');
  const summary = suite ? summarizeTests(readFileSync(suite.log, 'utf8')) : { failures: [] };
  if (!suiteCheck || !suite || suite.exitCode === 0)
    return { passed: true, reason: 'every step exited 0', ...empty, ran: summary.ran ?? '' };
  if (!comparable(suite, summary))
    return { passed: false, reason: 'the suite did not finish with a named result for every failure', ...empty };
  const base = await baseline();
  if (!base) return { passed: false, reason: `no comparable suite result for ${MAIN}`, ...empty };
  const onMain = new Set(base.failures);
  const known = summary.failures.filter((name) => onMain.has(name));
  let added = summary.failures.filter((name) => !onMain.has(name));
  let flaky: string[] = [];
  if (added.length && suiteCheck.rerun) {
    const files = [...new Set(added.map((name) => name.slice(0, name.indexOf(' > '))))].filter((file) => file !== '?');
    const rerun = await runCheck(
      { ...suiteCheck, name: `${suiteCheck.name} rerun`, argv: suiteCheck.rerun(files) },
      worktree,
      join(logs, 'test-suite-rerun.log'),
      print,
    );
    reportStep(rerun, print);
    const again = summarizeTests(readFileSync(rerun.log, 'utf8'));
    if (rerun.exitCode === 0 || comparable(rerun, again)) {
      const still = new Set(rerun.exitCode === 0 ? [] : again.failures);
      flaky = added.filter((name) => !still.has(name));
      added = added.filter((name) => still.has(name));
    }
  }
  const failures = summary.failures.filter((name) => !flaky.includes(name));
  const reason = added.length
    ? `${added.length} failing tests do not fail on ${MAIN}`
    : `${known.length} failing tests all fail on ${MAIN} too`;
  return { passed: added.length === 0, reason, ran: summary.ran ?? '', failures, known, added, flaky };
}

// ---------------------------------------------------------------------------------------------------------------
// Main's own suite result

export type Baseline = { version: 1; main: string; checks: string; time: string; ran: string; failures: string[] };

function checksKey(checks: readonly Check[]): string {
  return createHash('sha256')
    .update(JSON.stringify(checks.map((check) => [check.name, check.argv, check.cwd ?? ''])))
    .digest('hex')
    .slice(0, 12);
}

const baselineFile = (state: string, main: string, checks: readonly Check[]) =>
  join(state, 'cp-sync', `baseline-${main}-${checksKey(checks)}.json`);

function readBaseline(file: string, main: string, checks: readonly Check[]): Baseline | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Baseline;
    if (
      value.version === 1 &&
      value.main === main &&
      value.checks === checksKey(checks) &&
      Array.isArray(value.failures)
    )
      return value;
  } catch {}
  return undefined;
}

function writeBaseline(file: string, baseline: Baseline): void {
  assertNotDatabase(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
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

type Plan = { updates: RefUpdate[]; warnings: string[] };

/**
 * Main gets `next`; stabilize (when present) and dev merge it so main stays inside both and promotion can still
 * fast-forward. Dev keeps its own tree: everything the new main commit holds is already on dev (a sync) or is a
 * main-only emergency measure dev supersedes (a rollback). Stabilize takes the control-plane paths from main.
 */
function plan(
  cwd: string,
  mode: 'sync' | 'rollback',
  previous: string,
  next: string,
  paths: readonly string[],
  source?: string,
): Plan {
  const updates: RefUpdate[] = [{ ref: `refs/heads/${MAIN}`, previous, next }];
  const warnings: string[] = [];
  const dev = head(cwd, DEV);
  if (!dev) throw new Refusal(`Branch ${DEV} does not exist.`);
  if (source && !isAncestor(cwd, source, dev))
    throw new Refusal(`${DEV} no longer contains the synced source ${short(source)}; run again.`);
  let devParent = next;
  const stabilize = head(cwd, STABILIZE);
  if (stabilize && !isAncestor(cwd, next, stabilize)) {
    let keep = false;
    if (mode === 'sync') {
      const own = changedPaths(cwd, git(cwd, 'merge-base', stabilize, source!), stabilize, paths);
      if (own.length)
        throw new Refusal(
          `${STABILIZE} changed ${own.slice(0, 10).join(', ')} without ${DEV}; syncing would drop those changes.`,
        );
    } else if (changedPaths(cwd, previous, stabilize, paths).length) {
      keep = true;
      warnings.push(
        `${STABILIZE} has newer control-plane code than main; it keeps it, so its next promotion republishes it.`,
      );
    }
    const tree = keep ? git(cwd, 'rev-parse', `${stabilize}^{tree}`) : replacePaths(cwd, stabilize, next, paths);
    const merged = commitTree(cwd, tree, [stabilize, next], `Merge ${MAIN} into ${STABILIZE}`);
    updates.push({ ref: `refs/heads/${STABILIZE}`, previous: stabilize, next: merged });
    if (isAncestor(cwd, stabilize, dev)) devParent = merged;
  }
  if (!isAncestor(cwd, devParent, dev)) {
    const from = devParent === next ? MAIN : STABILIZE;
    const merged = commitTree(
      cwd,
      git(cwd, 'rev-parse', `${dev}^{tree}`),
      [dev, devParent],
      `Merge ${from} into ${DEV}`,
    );
    updates.push({ ref: `refs/heads/${DEV}`, previous: dev, next: merged });
  }
  return { updates, warnings };
}

/**
 * Moves the main checkout's index and files first, then the refs, so a control-plane process that restarts in
 * between loads the new code and only restarts once more; a failed transaction moves the files back.
 */
function publish(
  checkout: string,
  mode: 'sync' | 'rollback',
  previous: string,
  next: string,
  paths: readonly string[],
  source: string | undefined,
  print: (line: string) => void,
): Plan {
  assertCheckoutReady(checkout, previous, paths);
  const moved = run(checkout, ['read-tree', '-m', '-u', previous, next]);
  if (moved.status !== 0)
    throw new Refusal(`Could not update the main checkout's files: ${redact(moved.stderr.trim())}`);
  let published: Plan | undefined;
  let failure = '';
  try {
    for (let attempt = 0; attempt < 5 && !published; attempt++) {
      if (head(checkout, MAIN) !== previous) {
        failure = `${MAIN} moved during publication`;
        break;
      }
      const candidate = plan(checkout, mode, previous, next, paths, source);
      const result = transaction(checkout, candidate.updates);
      if (result.status === 0) published = candidate;
      else failure = redact(result.stderr.trim());
    }
  } finally {
    if (!published) {
      const back = run(checkout, ['read-tree', '-m', '-u', next, previous]);
      if (back.status !== 0)
        print(
          `cp-sync: could not restore the main checkout's files; run \`git -C ${checkout} read-tree -m -u ${next} ${previous}\`: ${redact(back.stderr.trim())}`,
        );
    }
  }
  if (!published) throw new Refusal(`No ref moved: ${failure}`);
  if (
    git(checkout, 'rev-parse', 'HEAD') !== next ||
    run(checkout, ['diff', '--quiet', 'HEAD', '--', ...paths]).status !== 0 ||
    run(checkout, ['diff', '--cached', '--quiet', 'HEAD', '--', ...paths]).status !== 0
  )
    print(`cp-sync: WARNING: the main checkout does not match ${short(next)} under ${paths.join(', ')}; inspect it.`);
  return published;
}

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
        timeoutMs: 10 * MINUTE,
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

export type ResidentHealth = { liveWorkers: number; passedGates: number; landings: number };
export type ResidentControl = {
  observe(checkout: string): Promise<ResidentHealth>;
  restart(checkout: string): Promise<void>;
};

/** A complete ten-minute window on each side of publication; sample worker width once per minute. */
export async function observeResident(
  checkout: string,
  pause: (milliseconds: number) => Promise<unknown> = (milliseconds) => Bun.sleep(milliseconds),
): Promise<ResidentHealth> {
  const file = join(checkout, '.temp/goal/goal.sqlite');
  const db = new Database(file, { readonly: true });
  const start = new Date().toISOString();
  let workers = 0;
  try {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    for (let minute = 0; minute < 10; minute++) {
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
      await pause(MINUTE);
    }
    const events = db
      .query(`SELECT body FROM worker_events WHERE kind = 'gate-outcome' AND at >= ? AND at < ?`)
      .all(start, new Date().toISOString()) as { body: string }[];
    const passed = events.map((row) => JSON.parse(row.body)).filter((outcome) => outcome.passed);
    return {
      liveWorkers: workers / 10,
      passedGates: passed.length,
      landings: passed.filter((outcome) => outcome.stage === 'merge' && outcome.mergedCommit).length,
    };
  } finally {
    db.close();
  }
}

export async function restartResident(checkout: string): Promise<void> {
  const envFile = join(checkout, '.temp/goal/goal.env');
  if (!existsSync(envFile)) throw new Refusal(`Goal service is not installed (${envFile}); run goal service install.`);
  const child = Bun.spawn(['systemctl', '--user', 'restart', 'rezics-goal-host.service'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Refusal((err || out).trim() || `systemctl restart: exit ${code}`);
}

export function residentRegression(before: ResidentHealth, after: ResidentHealth): boolean {
  return (
    after.liveWorkers < before.liveWorkers || after.passedGates < before.passedGates || after.landings < before.landings
  );
}
const residentControl: ResidentControl = { observe: observeResident, restart: restartResident };

export type Options = {
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
  const print = options.print ?? ((line: string) => console.log(redact(line)));
  const now = (options.now ?? (() => new Date()))();
  const checkout = findMainCheckout(options.cwd ?? process.cwd());
  const state = join(checkout, '.temp/goal');
  const main = head(checkout, MAIN)!;
  const source = head(checkout, DEV);
  if (!source) throw new Refusal(`Branch ${DEV} does not exist.`);
  const includes = validateIncludes(checkout, options.includes ?? [], main, source);
  const paths = [CONTROL_PLANE, ...includes];
  print(`cp-sync: ${options.dryRun ? 'dry run: ' : ''}${DEV} ${short(source)} -> ${MAIN} ${short(main)} (${checkout})`);
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
    if (activeChild) killGroup(activeChild.pid, 'SIGKILL');
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
  const interrupt = (signal: NodeJS.Signals) => {
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
    for (const line of git(worktree, 'diff', '--stat=120', main, tree).split('\n')) print(`  ${line}`);
    for (const missing of missingControlPlanePaths(checkout, main, tree))
      print(`cp-sync: WARNING: ${missing}, which the candidate lacks`);

    // The checks run on the committed candidate, as the main-release proof does, so tests that read the checkout's
    // HEAD see it. The commit stays unreachable on this detached worktree unless every step passes.
    git(worktree, 'commit', '--quiet', '-m', `control-plane: sync tools/goal from dev ${short(source)}`);
    const commit = git(worktree, 'rev-parse', 'HEAD');
    if (git(worktree, 'rev-parse', `${commit}^{tree}`) !== tree || git(worktree, 'rev-parse', `${commit}^`) !== main)
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
      throw new Refusal(`The checks changed the candidate checkout:\n${touched.split('\n').slice(0, 10).join('\n')}`);
    print(`cp-sync: checks passed (${verdict.reason}); sync commit ${short(commit)}`);

    if (options.dryRun) {
      const preview = plan(checkout, 'sync', main, commit, paths, source);
      for (const update of preview.updates)
        print(`cp-sync: would move ${update.ref} ${short(update.previous)} -> ${short(update.next)}`);
      for (const warning of preview.warnings) print(`cp-sync: ${warning}`);
      print(`cp-sync: dry run; no ref or checkout moved.${ready ? '' : ' A real run would refuse (see above).'}`);
      return ready ? 0 : 1;
    }

    const resident = options.resident ?? residentControl;
    print('cp-sync: observing resident workers and gate outcomes for ten minutes before publication.');
    const before = await resident.observe(checkout);
    const published = publish(checkout, 'sync', main, commit, paths, source, print);
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
    if (!(await reinstall(checkout, main, commit, paths, logs, print))) {
      print('cp-sync: the main checkout install failed; fix it, or run cp-sync --rollback.');
      return 1;
    }
    try {
      await resident.restart(checkout);
      print('cp-sync: observing resident workers and gate outcomes for ten minutes after publication.');
      const after = await resident.observe(checkout);
      print(`cp-sync: resident before ${JSON.stringify(before)}; after ${JSON.stringify(after)}`);
      if (residentRegression(before, after))
        throw new Refusal('Resident workers, successful gate outcomes or landings dropped.');
    } catch (error) {
      print(`cp-sync: ${error instanceof Error ? error.message : String(error)}; rolling back.`);
      // Release this sync's lock before invoking the ordinary forward-only rollback transaction.
      cleanup();
      await rollback({ ...options, resident });
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
}

export async function rollback(options: Options = {}): Promise<number> {
  const print = options.print ?? ((line: string) => console.log(redact(line)));
  const now = (options.now ?? (() => new Date()))();
  const checkout = findMainCheckout(options.cwd ?? process.cwd());
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
  for (const line of git(checkout, 'diff', '--stat=120', current, tree).split('\n')) print(`  ${line}`);
  const release = options.dryRun ? () => {} : lock(join(state, 'cp-sync.lock'));
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
      for (const update of plan(checkout, 'rollback', current, commit, paths).updates)
        print(`cp-sync: would move ${update.ref} ${short(update.previous)} -> ${short(update.next)}`);
      print('cp-sync: dry run; no ref or checkout moved.');
      return 0;
    }
    const published = publish(checkout, 'rollback', current, commit, paths, undefined, print);
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
    if (!(await reinstall(checkout, current, commit, paths, logs, print))) return 1;
    await (options.resident ?? residentControl).restart(checkout);
    print(`cp-sync: ${MAIN} runs the ${CONTROL_PLANE} of ${short(target.main.previous)} again.`);
    return 0;
  } finally {
    release();
  }
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
