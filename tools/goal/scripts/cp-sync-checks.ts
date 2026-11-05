/**
 * Candidate validation for cp-sync: check descriptions, copied-state smoke, process execution, output interpretation
 * and baseline comparison. Importing this module does not install signal handlers or run checks.
 */
import { scriptPolicy } from '../src/script-policy.ts';
import { defaultPolicy, type ControlPolicy } from '../src/policy.ts';
import { Database } from 'bun:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAIN = 'main';
const MINUTE = 60_000;

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
export function configSmoke(checkout: string, policy = scriptPolicy()): Check {
  return {
    name: 'config smoke',
    argv: ['bun', 'tools/goal/scripts/cp-config-smoke.ts'],
    timeoutMs: policy.cpSync.configSmokeTimeoutMs,
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
export function cliSmoke(checkout: string, policy = scriptPolicy()): Check {
  return {
    name: 'cli smoke',
    argv: ['bun', 'tools/goal/src/cli.ts', 'status'],
    timeoutMs: policy.cpSync.cliSmokeTimeoutMs,
    kind: 'smoke',
    env: (worktree) => ({
      GOAL_MAIN_CHECKOUT: checkout,
      GOAL_LOCAL_CONFIG: join(checkout, '.temp/goal/local.json'),
      GOAL_STATE_DIRECTORY: join(worktree, SMOKE_STATE),
      GOAL_MANAGER: 'cp-sync-smoke',
    }),
  };
}

export function proofChecks(policy: ControlPolicy): readonly Check[] {
  const suite = ['bun', 'test', '--timeout', String(policy.cpSync.testTimeoutMs)];
  // The install, typing and suite steps of the main-release proof (CONTROL_PLANE_CHECKS in src/merge-train.ts).
  return [
    {
      name: 'root install',
      argv: ['bun', 'install', '--frozen-lockfile'],
      timeoutMs: policy.cpSync.installTimeoutMs,
      kind: 'prepare',
    },
    {
      name: 'tools/goal install',
      argv: ['bun', 'install', '--frozen-lockfile', '--cwd', 'tools/goal'],
      timeoutMs: policy.cpSync.installTimeoutMs,
      kind: 'prepare',
    },
    {
      name: 'type check',
      argv: ['bun', 'run', '--cwd', 'tools/goal', 'typecheck'],
      timeoutMs: policy.cpSync.typecheckTimeoutMs,
      kind: 'typecheck',
    },
    {
      name: 'test suite',
      argv: [...suite, 'tools/goal/src'],
      timeoutMs: policy.cpSync.suiteTimeoutMs,
      kind: 'suite',
      rerun: (files) => [...suite, ...files],
    },
  ];
}
export const PROOF_CHECKS = proofChecks(defaultPolicy);

/** Installs, the type check, live config/routing parse and the CLI smoke; `full` adds the suite. */
export function syncChecks(checkout: string, full = false, policy = scriptPolicy()): Check[] {
  const checks = proofChecks(policy);
  const suite = checks.filter((check) => check.kind === 'suite');
  return [
    ...checks.filter((check) => check.kind !== 'suite'),
    configSmoke(checkout, policy),
    cliSmoke(checkout, policy),
    ...(full ? suite : []),
  ];
}

/** Copies the live Goal database for a smoke check without writing it: a read-only connection's VACUUM INTO. */
export function copyDatabase(source: string, directory: string): boolean {
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

export function assertNotDatabase(path: string): void {
  if (/goal\.sqlite/.test(path)) throw new Error(`cp-sync never writes the Goal database (${path})`);
}

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

/** Stops the check currently owned by runCheck, including a publication reinstall, if any. */
export function stopOwnedCheck(): void {
  if (activeChild) killGroup(activeChild.pid, 'SIGKILL');
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
    setTimeout(() => killGroup(child.pid, 'SIGKILL'), scriptPolicy().cpSync.terminationGraceMs).unref();
  }, check.timeoutMs);
  const heartbeat = setInterval(
    () => print(`cp-sync: ${check.name} running (${Math.round((Date.now() - started) / MINUTE)} min)`),
    scriptPolicy().cpSync.heartbeatMs,
  );
  const exitCode = await new Promise<number>((done) => {
    child.on('error', (error) => {
      appendFileSync(log, `${redact(error.message)}\n`);
      done(127);
    });
    child.on('exit', (code, signal) => {
      // Output pipes can stay open in leftover group members; give them a moment, then stop the group.
      const finish = () => done(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 1));
      const grace = setTimeout(finish, scriptPolicy().cpSync.pipeGraceMs);
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
export function comparable(step: StepResult, summary: TestSummary): boolean {
  return (
    !step.timedOut &&
    summary.ran !== undefined &&
    (summary.fail ?? 0) === summary.failures.length &&
    step.exitCode < 128
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function reportStep(step: StepResult, print: (line: string) => void): void {
  const verdict = step.timedOut ? 'TIMED OUT' : step.exitCode === 0 ? 'ok' : 'FAILED';
  print(`cp-sync: ${step.name}: exit ${step.exitCode}, ${seconds(step.durationMs)} ${verdict} (log ${step.log})`);
  const output = readFileSync(step.log, 'utf8');
  if (step.kind === 'suite') {
    const summary = summarizeTests(output);
    print(`  ${summary.ran ?? 'no test summary'}: ${summary.pass ?? '?'} pass, ${summary.fail ?? '?'} fail`);
  } else if (step.exitCode !== 0) {
    // Compiler diagnostics lead; install failures end with their cause.
    const lines = output.trimEnd().split('\n').slice(1);
    for (const line of step.kind === 'typecheck'
      ? lines.slice(0, scriptPolicy().cpSync.compilerLines)
      : lines.slice(-scriptPolicy().cpSync.failureLines))
      print(`  | ${line}`);
  }
}

/** Runs checks in order; a failed preparation always ends the run, and other failures end it unless `keepGoing`. */
export async function runChecks(
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
export async function gate(
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

export type Baseline = { version: 1; main: string; checks: string; time: string; ran: string; failures: string[] };

export function checksKey(checks: readonly Check[]): string {
  return createHash('sha256')
    .update(JSON.stringify(checks.map((check) => [check.name, check.argv, check.cwd ?? ''])))
    .digest('hex')
    .slice(0, 12);
}

export const baselineFile = (state: string, main: string, checks: readonly Check[]) =>
  join(state, 'cp-sync', `baseline-${main}-${checksKey(checks)}.json`);

export function readBaseline(file: string, main: string, checks: readonly Check[]): Baseline | undefined {
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

export function writeBaseline(file: string, baseline: Baseline): void {
  assertNotDatabase(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
}
