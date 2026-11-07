import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One combined check plus one rerun after that check failed. */
export const WORKER_CHECK_HOST_RUN_LIMIT = 2;
export const WORKER_CHECK_HOST_BUDGET_REFUSAL =
  'Check-host budget exhausted: this attempt already used its one check and one rerun. Finish the outcome and return success or a blocker.';
export const WORKER_CHECK_HOST_TYPECHECK_REFUSAL =
  "Check-host budget exhausted: this attempt's final verification run failed its typecheck. Return a blocker naming those type errors, not success.";
/** Transport, upload or probe failure before the check command ran (`scripts/remote-check.ts`). */
export const WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT = 75;
export const WORKER_CHECK_TESTS_AFTER_LANDING = 'Tests run after landing in the dev verifier.';
const STAMP_NAME = /^[1-9]\d*$/;
const TYPECHECK_COMMAND = /\btypecheck\b|scripts\/typecheck\.ts/;
const TYPECHECK_FAILURE =
  /error TS\d+|error: script "typecheck" exited|error:\s*"typecheck" exited|error: Failed to run .*typecheck/;
const TYPING_LOG_CHARACTERS = 8192;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const MONEY_DIRECTORY = /(^|\/)(?:commerce|checkout|payouts?|payments?|balance|points)(\/|$)/i;
const MONEY_FILE = /(^|\/)(?:payouts?|payments?|balance)(?:[-.]|$)/i;
const BROWSER_COMMAND = /(?:^|\/)(?:playwright|puppeteer|cypress|chrom(?:e|ium)|storybook)(?:$|[/\s.-])/i;
const GROWTH_COMMAND = /(?:^|\/)growth(?:\.ts)?$/i;
const NATIVE_COMMAND = /(?:^|\/)(?:isolated\.ts|check\.ts)$|(?:^|\/)auth-binding-host(?:$|[/\s.-])/i;
const TYPECHECK_ARGUMENT = /(?:^|\/)typecheck(?:\.ts)?$/;
const SHELL = new Set(['sh', 'bash', 'dash', 'zsh']);
const SKIP_STATEMENT = /^(?:s=\$\?|s=1|exit(?:\s+\$s)?)$/;

export type WorkerCheckHostBudgetLimit = typeof WORKER_CHECK_HOST_RUN_LIMIT | 'off';

export type WorkerCheckBudgetTask = {
  brief?: {
    goal?: string;
    kind?: string;
    urgent?: boolean;
    acceptance?: { requires?: readonly string[] };
  };
  proofRun?: { binding?: { attempt?: number } } | null;
  proofAuthorization?: unknown;
};

/** Native receipt fields that prove the remote check command started. */
export type WorkerCheckHostCommandReceipt = {
  resources?: { commandStartedMonoMs?: number | null } | null;
};

export type WorkerCheckHostStampRecord = {
  content?: string;
  final?: boolean;
  exitCode?: number;
  typecheckFailed?: boolean;
  includedTypecheck?: boolean;
  log?: string;
};

/** Controller-owned stamp directory beside the attempt's check-wait file. */
export function workerCheckBudgetDirectory(stateDirectory: string, taskId: string, attempt: number): string {
  return join(stateDirectory, 'runs', taskId, `${attempt}.check-host-runs`);
}

/**
 * Proof-run, registered-proof and acceptance-requiring briefs keep their declared checks. Urgent and control-plane
 * tasks are exempt. Everyone else is held to one check-host wrapper run plus one rerun after a failure.
 */
export function workerCheckHostBudgetLimit(task: WorkerCheckBudgetTask, attempt?: number): WorkerCheckHostBudgetLimit {
  const brief = task.brief;
  if (brief?.urgent === true || brief?.goal === 'control-plane') return 'off';
  if ((brief?.acceptance?.requires?.length ?? 0) > 0) return 'off';
  if (brief?.kind === 'verification' && task.proofAuthorization) return 'off';
  if (brief?.kind === 'verification' && attempt !== undefined && task.proofRun?.binding?.attempt === attempt)
    return 'off';
  return WORKER_CHECK_HOST_RUN_LIMIT;
}

export function workerCheckHostRunsUsed(directory: string): number {
  try {
    return stampNames(directory).length;
  } catch {
    return 0;
  }
}

function stampNames(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => STAMP_NAME.test(name))
    .sort((left, right) => Number(left) - Number(right));
}

function nextWorkerCheckHostStamp(directory: string): string {
  const names = new Set(stampNames(directory));
  for (let n = 1; ; n += 1) {
    const stamp = String(n);
    if (!names.has(stamp)) return stamp;
  }
}

function git(worktree: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  return result.stdout;
}

/** Tree of the worktree contents, including uncommitted edits and untracked files Git does not ignore. */
export function workerCheckHostContentTree(worktree: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'goal-check-tree-'));
  const index = join(directory, 'index');
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(worktree, ['read-tree', 'HEAD'], env);
    git(worktree, ['add', '-A'], env);
    return git(worktree, ['write-tree'], env).trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readWorkerCheckHostStamp(directory: string, stamp: string): WorkerCheckHostStampRecord {
  const raw = readFileSync(join(directory, stamp), 'utf8').trim();
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`worker check-host stamp ${stamp} is not an object`);
  return value as WorkerCheckHostStampRecord;
}

function writeStamp(directory: string, stamp: string, record: WorkerCheckHostStampRecord, flag?: 'wx'): void {
  writeFileSync(join(directory, stamp), `${JSON.stringify(record)}\n`, flag ? { flag } : undefined);
}

function lastStamp(directory: string): { name: string; record: WorkerCheckHostStampRecord } | undefined {
  const names = stampNames(directory);
  const name = names.at(-1);
  return name ? { name, record: readWorkerCheckHostStamp(directory, name) } : undefined;
}

export function checkCommandIncludesTypecheck(argv: readonly string[] | undefined, log = ''): boolean {
  if (argv?.some((part) => TYPECHECK_COMMAND.test(part))) return true;
  return TYPECHECK_COMMAND.test(log);
}

export function workerCheckHostTypecheckFailed(log: string, argv?: readonly string[]): boolean {
  if (!checkCommandIncludesTypecheck(argv, log)) return TYPECHECK_FAILURE.test(log);
  return TYPECHECK_FAILURE.test(log);
}

function boundedLog(path: string | undefined): string {
  if (!path) return '(check log unavailable)';
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= TYPING_LOG_CHARACTERS ? text : text.slice(-TYPING_LOG_CHARACTERS);
  } catch {
    return `(check log unavailable: ${path})`;
  }
}

export type WorkerCheckHostAdmit = {
  directory?: string | undefined;
  limit?: string | number | null | undefined;
  worktree?: string | undefined;
};

export type WorkerCheckHostAdmitResult =
  | { ok: true; used: number; stamp: string }
  | { ok: true; used: 0 }
  | { ok: false; used: number; message: string };

function budgetRefused(
  last: WorkerCheckHostStampRecord | undefined,
  used: number,
): Extract<WorkerCheckHostAdmitResult, { ok: false }> {
  return {
    ok: false,
    used,
    message:
      last?.final === true && last.typecheckFailed === true
        ? WORKER_CHECK_HOST_TYPECHECK_REFUSAL
        : WORKER_CHECK_HOST_BUDGET_REFUSAL,
  };
}

function admitsFinalVerification(last: WorkerCheckHostStampRecord | undefined, worktree: string | undefined): boolean {
  if (!last || last.final === true) return false;
  if (typeof last.exitCode !== 'number' || last.exitCode === 0) return false;
  if (!last.content || !worktree) return false;
  return workerCheckHostContentTree(worktree) !== last.content;
}

/**
 * Record one check-host wrapper request for this attempt. Missing controller state does not invent a budget.
 * A third request is the final verification run when the last counted run failed and the worktree changed; any
 * further request, or a third request on unchanged content, is refused before the caller reserves a host.
 */
export function admitWorkerCheckHostRun(input: WorkerCheckHostAdmit): WorkerCheckHostAdmitResult {
  const directory = input.directory?.trim();
  if (!directory) return { ok: true, used: 0 };
  const exempt = input.limit === 'off' || input.limit === null;
  mkdirSync(directory, { recursive: true });
  for (;;) {
    const used = workerCheckHostRunsUsed(directory);
    const last = used > 0 ? lastStamp(directory) : undefined;
    const final = !exempt && used >= WORKER_CHECK_HOST_RUN_LIMIT;
    if (final && !admitsFinalVerification(last?.record, input.worktree)) return budgetRefused(last?.record, used);
    const stamp = nextWorkerCheckHostStamp(directory);
    const record: WorkerCheckHostStampRecord = {
      ...(input.worktree ? { content: workerCheckHostContentTree(input.worktree) } : {}),
      ...(final ? { final: true } : {}),
    };
    try {
      writeStamp(directory, stamp, record, 'wx');
      return { ok: true, used: used + 1, stamp };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
  }
}

/** Wrapper entry: no-op for local placement and for workers the controller did not launch. */
export function refuseExcessWorkerCheckHostRun(
  env: NodeJS.ProcessEnv,
  placesOnCheckHost: boolean,
  worktree?: string,
): void {
  if (!placesOnCheckHost) return;
  const admitted = admitWorkerCheckHostRun({
    directory: env.GOAL_WORKER_CHECK_BUDGET_DIR,
    limit: env.GOAL_WORKER_CHECK_BUDGET,
    worktree,
  });
  if (!admitted.ok) throw new Error(admitted.message);
  if ('stamp' in admitted) env.GOAL_WORKER_CHECK_BUDGET_STAMP = admitted.stamp;
}

export function workerCheckHostCommandReached(receipt: WorkerCheckHostCommandReceipt | null | undefined): boolean {
  return receipt?.resources?.commandStartedMonoMs != null;
}

export type WorkerCheckHostSettle = {
  log?: string;
  argv?: readonly string[];
};

/**
 * Give this wrapper run's stamp back when it died with infrastructure exit 75 before the check command ran.
 * Otherwise record the run's exit and whether its typecheck failed, so admission and settlement can see it.
 * The wrapper calls this where it records the run's final exit code.
 */
export function settleWorkerCheckHostBudget(
  env: NodeJS.ProcessEnv,
  exitCode: number,
  commandReached: boolean,
  details: WorkerCheckHostSettle = {},
): void {
  const directory = env.GOAL_WORKER_CHECK_BUDGET_DIR?.trim();
  const stamp = env.GOAL_WORKER_CHECK_BUDGET_STAMP?.trim();
  if (!directory || !stamp || !STAMP_NAME.test(stamp)) return;
  if (exitCode === WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT && !commandReached) {
    try {
      unlinkSync(join(directory, stamp));
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    return;
  }
  let current: WorkerCheckHostStampRecord = {};
  try {
    current = readWorkerCheckHostStamp(directory, stamp);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return;
    throw error;
  }
  const log = details.log ? boundedLog(details.log) : '';
  writeStamp(directory, stamp, {
    ...current,
    exitCode,
    includedTypecheck: checkCommandIncludesTypecheck(details.argv, log),
    typecheckFailed: workerCheckHostTypecheckFailed(log, details.argv),
    ...(details.log ? { log: details.log } : {}),
  });
}

export type WorkerCheckHostTypingSettlement = { ok: true } | { ok: false; result: string };

/**
 * Product outcomes land when they type-check. A success report after a failed last host typecheck, or after the
 * worktree changed since that typecheck, is recorded as a typing failure so the attempt is retried instead of landing.
 * Failing tests alone keep today's handling. Exempt briefs skip this guard.
 */
export function workerCheckHostTypingSettlement(input: {
  directory?: string | undefined;
  worktree: string;
  limit?: string | number | null | undefined;
}): WorkerCheckHostTypingSettlement {
  const directory = input.directory?.trim();
  if (!directory || input.limit === 'off' || input.limit === null) return { ok: true };
  let names: string[];
  try {
    names = stampNames(directory);
  } catch {
    return { ok: true };
  }
  if (names.length === 0) return { ok: true };
  const records = names.map((name) => readWorkerCheckHostStamp(directory, name));
  const last = records.at(-1);
  const lastTypecheck = records.findLast((record) => record.includedTypecheck);
  const failed = last?.includedTypecheck === true && last.typecheckFailed === true;
  const changed =
    lastTypecheck?.content !== undefined && workerCheckHostContentTree(input.worktree) !== lastTypecheck.content;
  if (!failed && !changed) return { ok: true };
  const source = failed ? last : lastTypecheck;
  const reason = failed
    ? 'Last check-host run failed its typecheck.'
    : 'Worktree content changed after the last check-host typecheck.';
  return {
    ok: false,
    result: `${reason} Settlement records a typing failure with that run's log, so this attempt is retried instead of landing.\n${source?.log ? boundedLog(source.log) : '(check log unavailable)'}`,
  };
}

export function isMoneyPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return MONEY_DIRECTORY.test(normalized) || MONEY_FILE.test(normalized);
}

export function isTypecheckCommand(command: readonly string[]): boolean {
  return command.some((part) => TYPECHECK_ARGUMENT.test(part)) || commandIncludesTypecheckFlag(command);
}

function commandIncludesTypecheckFlag(command: readonly string[]): boolean {
  const bun = command[0] === 'env' || command[0] === 'bun' || (command[0]?.endsWith('/bun') ?? false);
  if (!bun) return command[0] === 'tsc' && command.includes('--noEmit');
  return command.includes('check') && command.includes('--no-script');
}

export function worktreeChangedPaths(cwd: string): string[] {
  const git = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0) return [];
  const dev = git(['rev-parse', '--verify', 'dev^{commit}']);
  const merge = dev.status === 0 ? git(['merge-base', 'HEAD', 'dev']) : undefined;
  const from = merge?.status === 0 && merge.stdout.trim() ? merge.stdout.trim() : 'HEAD';
  const diff = git(['diff', '--name-only', '--no-renames', from]);
  const cached = git(['diff', '--name-only', '--no-renames', '--cached', from === 'HEAD' ? 'HEAD' : from]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [
    ...new Set(
      [
        ...(diff.status === 0 ? diff.stdout.split('\n') : []),
        ...(cached.status === 0 ? cached.stdout.split('\n') : []),
        ...(untracked.status === 0 ? untracked.stdout.split('\n') : []),
      ].filter(Boolean),
    ),
  ];
}

function wrapperExecutionArgv(argv: readonly string[]): string[] {
  let index = 0;
  while (argv[index] === '--local' || argv[index] === '--returns') index += argv[index] === '--returns' ? 2 : 1;
  if (argv[index] === '--') index += 1;
  return argv.slice(index);
}

function stripEnvironmentPrefix(argv: readonly string[]): string[] {
  if (argv[0] !== 'env') return [...argv];
  let index = 1;
  while (index < argv.length) {
    const argument = argv[index]!;
    if (argument === '--' || argument === '-u' || argument === '--unset' || argument.startsWith('--unset=')) {
      if (argument === '-u' || argument === '--unset') index += 2;
      else index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
      index += 1;
      continue;
    }
    break;
  }
  return argv.slice(index);
}

function tokenize(statement: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  for (const character of statement.trim()) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function expandCheckCommands(argv: readonly string[]): string[][] {
  const command = stripEnvironmentPrefix(wrapperExecutionArgv(argv));
  const name = command[0]?.split(/[\\/]/).at(-1);
  if (name && SHELL.has(name) && (command[1] === '-c' || command[1] === '-lc') && command[2]) {
    return command[2]
      .split(/(?:;|\|\||&&)/)
      .map((part) => part.trim())
      .filter((part) => part && !SKIP_STATEMENT.test(part))
      .map(tokenize)
      .filter((tokens) => tokens.length > 0);
  }
  return command.length ? [command] : [];
}

export type OrdinaryProductCheckKind = 'typecheck' | 'money-test' | 'test' | 'native' | 'browser' | 'growth' | 'other';

function commandHas(command: readonly string[], pattern: RegExp): boolean {
  return command.some((part) => pattern.test(part));
}

function testFilesIn(command: readonly string[]): string[] {
  return command.filter((part) => TEST_FILE.test(part));
}

export function classifyOrdinaryProductCommand(command: readonly string[]): OrdinaryProductCheckKind {
  const parts = stripEnvironmentPrefix(command);
  if (isTypecheckCommand(parts)) return 'typecheck';
  const files = testFilesIn(parts);
  if (files.length && files.every(isMoneyPath)) return 'money-test';
  if (commandHas(parts, GROWTH_COMMAND) || command.some((part) => part.startsWith('GROWTH_PROFILE='))) return 'growth';
  if (commandHas(parts, BROWSER_COMMAND)) return 'browser';
  if (commandHas(parts, NATIVE_COMMAND)) return 'native';
  if (
    parts.includes('check') &&
    parts.some((part) => part.includes('services/kernel') || part.includes('services/auth'))
  )
    return 'native';
  if (files.length || parts.includes('test') || parts.some((part) => part.endsWith('focused.ts'))) return 'test';
  if (parts.includes('check')) return 'native';
  return 'other';
}

export function ordinaryProductCheckRefusal(argv: readonly string[], moneyChanged: boolean): string | undefined {
  const commands = expandCheckCommands(argv);
  if (!commands.length) return undefined;
  const kinds = commands.map(classifyOrdinaryProductCommand);
  if (kinds.every((kind) => kind === 'typecheck')) return undefined;
  if (kinds.every((kind) => kind === 'typecheck' || kind === 'money-test') && moneyChanged) return undefined;
  return WORKER_CHECK_TESTS_AFTER_LANDING;
}

/**
 * Ordinary product attempts may typecheck changed workspaces, plus money-path tests when those paths changed.
 * A test file, native, browser or growth command is refused before any upload. Exempt briefs keep declared checks.
 */
export function refuseOrdinaryProductTestCheck(env: NodeJS.ProcessEnv, argv: readonly string[], cwd: string): void {
  if (!env.GOAL_WORKER_CHECK_BUDGET_DIR?.trim()) return;
  if (env.GOAL_WORKER_CHECK_BUDGET === 'off') return;
  const moneyChanged = worktreeChangedPaths(cwd).some(isMoneyPath);
  const message = ordinaryProductCheckRefusal(argv, moneyChanged);
  if (message) throw new Error(message);
}
