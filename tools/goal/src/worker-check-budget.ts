import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One combined check plus one rerun after that check failed. */
export const WORKER_CHECK_HOST_RUN_LIMIT = 2;
export const WORKER_CHECK_HOST_BUDGET_REFUSAL =
  'Check-host budget exhausted: this attempt already used its one check and one rerun. Finish the outcome and return success or a blocker.';
/** Transport, upload or probe failure before the check command ran (`scripts/remote-check.ts`). */
export const WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT = 75;
export const WORKER_CHECK_TESTS_AFTER_LANDING = 'Tests run after landing in the dev verifier.';
const STAMP_NAME = /^[1-9]\d*$/;
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
    return readdirSync(directory).filter((name) => STAMP_NAME.test(name)).length;
  } catch {
    return 0;
  }
}

function nextWorkerCheckHostStamp(directory: string): string {
  const names = new Set(readdirSync(directory).filter((name) => STAMP_NAME.test(name)));
  for (let n = 1; ; n += 1) {
    const stamp = String(n);
    if (!names.has(stamp)) return stamp;
  }
}

export type WorkerCheckHostAdmit = {
  directory?: string | undefined;
  limit?: string | number | null | undefined;
};

export type WorkerCheckHostAdmitResult =
  | { ok: true; used: number; stamp: string }
  | { ok: true; used: 0 }
  | { ok: false; used: number; message: string };

/**
 * Record one check-host wrapper request for this attempt. Missing controller state does not invent a budget.
 * A third request is refused before the caller reserves a host.
 */
export function admitWorkerCheckHostRun(input: WorkerCheckHostAdmit): WorkerCheckHostAdmitResult {
  const directory = input.directory?.trim();
  if (!directory) return { ok: true, used: 0 };
  const exempt = input.limit === 'off' || input.limit === null;
  mkdirSync(directory, { recursive: true });
  for (;;) {
    const used = workerCheckHostRunsUsed(directory);
    if (!exempt && used >= WORKER_CHECK_HOST_RUN_LIMIT)
      return { ok: false, used, message: WORKER_CHECK_HOST_BUDGET_REFUSAL };
    const stamp = nextWorkerCheckHostStamp(directory);
    try {
      writeFileSync(join(directory, stamp), '', { flag: 'wx' });
      return { ok: true, used: used + 1, stamp };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
  }
}

/** Wrapper entry: no-op for local placement and for workers the controller did not launch. */
export function refuseExcessWorkerCheckHostRun(env: NodeJS.ProcessEnv, placesOnCheckHost: boolean): void {
  if (!placesOnCheckHost) return;
  const admitted = admitWorkerCheckHostRun({
    directory: env.GOAL_WORKER_CHECK_BUDGET_DIR,
    limit: env.GOAL_WORKER_CHECK_BUDGET,
  });
  if (!admitted.ok) throw new Error(admitted.message);
  if ('stamp' in admitted) env.GOAL_WORKER_CHECK_BUDGET_STAMP = admitted.stamp;
}

export function workerCheckHostCommandReached(receipt: WorkerCheckHostCommandReceipt | null | undefined): boolean {
  return receipt?.resources?.commandStartedMonoMs != null;
}

/**
 * Give this wrapper run's stamp back when it died with infrastructure exit 75 before the check command ran.
 * The wrapper calls this where it records the run's final exit code.
 */
export function settleWorkerCheckHostBudget(env: NodeJS.ProcessEnv, exitCode: number, commandReached: boolean): void {
  if (exitCode !== WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT || commandReached) return;
  const directory = env.GOAL_WORKER_CHECK_BUDGET_DIR?.trim();
  const stamp = env.GOAL_WORKER_CHECK_BUDGET_STAMP?.trim();
  if (!directory || !stamp || !STAMP_NAME.test(stamp)) return;
  try {
    unlinkSync(join(directory, stamp));
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
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

export function verifierFailureRevertsLanding(check: {
  command: readonly string[];
  closure?: readonly string[];
}): boolean {
  if (isTypecheckCommand(check.command)) return true;
  return [...check.command, ...(check.closure ?? [])].some((part) => isMoneyPath(part));
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
