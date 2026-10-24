import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { git, readLedger, pidAlive } from './ledger.ts';
import { running } from './launch.ts';
import { directoryLeaseHeld, readDirectoryLease, tryAcquireDirectoryLease, type AcquiredDirectoryLease } from '../qa/process/lease.ts';
import type { SlotRunOptions } from './qa-slots.ts';
import type { Ledger } from './types.ts';
import { selectTestGroups } from '../qa/test.ts';

const namedFile = /\.(?:test|spec|e2e|stories)\.[cm]?[jt]sx?$/;

/** Classify the invocation before expanding affected plans or suites into their files. */
export function isWideRun(command: readonly string[]): boolean {
  const args = [...command];
  const program = basename(args[0] ?? '');
  const script = basename(args[1] ?? '');
  const goalctl = program === 'goalctl.ts' ? 0 : program === 'bun' && script === 'goalctl.ts' ? 1 : -1;
  if (goalctl >= 0) {
    const action = args[goalctl + 1];
    if (action === 'regress') return !args.includes('--timing'); // the timing report reads a finished run
    if (action === 'slot') return isWideRun(args.slice(goalctl + 2).filter(arg => !['--', '--heavy', '--beside-workers'].includes(arg)));
    if (action === 'test') return isWideRun(['test.ts', ...args.slice(goalctl + 2)]);
  }
  if (program === 'task' && args[1] === 'goal') return isWideRun(['goalctl.ts', ...args.slice(2).filter(arg => arg !== '--')]);
  const task = program === 'task' ? args[1] : undefined;
  const qaCommand = ['vitest', 'playwright', 'test.ts', 'cli.ts'].includes(program)
    || (program === 'bun' && ['test', 'test.ts', 'cli.ts'].includes(script))
    || ['test', 'qa', 'storybook:test', 'accounts:storybook:test', 'web:e2e', 'accounts:e2e'].includes(task ?? '');
  if (!qaCommand) return false;
  // Option values such as reports and configs are not selected test files.
  const selected = args.filter((arg, index) => !['--config', '--result-file', '--reporter-outfile', '--outputFile'].includes(args[index - 1] ?? ''));
  if (selected.some(arg => namedFile.test(arg))) return false;
  if (args.some(arg => arg === '--affected' || arg.startsWith('--affected='))) return !args.includes('--list');
  if (args.includes('--tier')) return true;
  return true;
}

export function qaGoal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GOAL_ID) return env.GOAL_ID;
  return env.GOAL_TASK_ID ? readLedger().tasks[env.GOAL_TASK_ID]?.goal : undefined;
}

export function assertWideRunAllowed(command: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  if (isWideRun(command) && (env.GOAL_TASK_ID || (env.GOAL_ID && env.GOAL_ID !== 'program'))) {
    throw new Error('Wide QA is reserved for the program; run bun scripts/goal/goalctl.ts test <named test files> instead.');
  }
}

export function liveWorkerGoals(): string[] {
  return Object.values(readLedger().tasks).filter(task => task.state === 'running' && running(task)).map(task => task.goal ?? '?');
}

export interface SlotShareOptions {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => number;
  alive?: (pid: number) => boolean;
  workerGoals?: () => string[];
}

export function slotHolders(directory: string, total: number, alive = pidAlive): { slot: number; goal?: string; task?: string; pid: number }[] {
  const holders: { slot: number; goal?: string; task?: string; pid: number }[] = [];
  for (let slot = 0; slot < total; slot++) {
    const path = join(directory, String(slot));
    if (!directoryLeaseHeld(path, { alive })) continue;
    const record = readDirectoryLease(path);
    if (record && !record.invalid) holders.push({ slot, goal: record.goal, task: record.task, pid: record.pid });
  }
  return holders;
}

export function slotHolderLines(directory: string, total: number): string[] {
  return slotHolders(directory, total).sort((a, b) => (a.goal ?? '?').localeCompare(b.goal ?? '?') || a.slot - b.slot)
    .map(holder => `Goal ${holder.goal ?? '?'}: slot ${holder.slot}, task ${holder.task ?? 'manager/terminal'} (pid ${holder.pid})`);
}

function otherGoalWaiting(directory: string, goal: string, alive: (pid: number) => boolean): boolean {
  const waiters = join(directory, 'waiters');
  if (!existsSync(waiters)) return false;
  return readdirSync(waiters).some(name => {
    // Diagnostic waits can outlive a nonblocking request. Share reservations,
    // like queue turns, belong only to outstanding acquisition tickets.
    if (!name.startsWith('ordered-slot-') || !name.endsWith('.json')) return false;
    try {
      const record = JSON.parse(readFileSync(join(waiters, name), 'utf8')) as { goal?: string; pid: number; waitingFor?: string };
      return alive(record.pid) && record.waitingFor === 'slot' && !!record.goal && record.goal !== goal;
    } catch { return false; }
  });
}

/** Serialize the share decision with acquisition, so simultaneous shards cannot exceed their share. */
export function tryAcquireQaSlot(directory: string, total: number, slot: number, options: SlotShareOptions = {}): AcquiredDirectoryLease | 'held' {
  const env = options.env ?? process.env;
  const goal = qaGoal(env);
  const pid = options.pid ?? process.pid;
  const alive = options.alive ?? pidAlive;
  mkdirSync(directory, { recursive: true });
  const guard = tryAcquireDirectoryLease(join(directory, 'shares'), { pid, alive, now: options.now });
  if (guard === 'held') return 'held';
  try {
    const goals = new Set((options.workerGoals ?? liveWorkerGoals)());
    const share = Math.max(1, Math.floor(total / Math.max(1, goals.size)));
    if (goal && goal !== 'program' && goals.has(goal)
      && slotHolders(directory, total, alive).filter(holder => holder.goal === goal).length >= share
      && otherGoalWaiting(directory, goal, alive)) return 'held';
    return tryAcquireDirectoryLease(join(directory, String(slot)), { pid, alive, now: options.now,
      note: { goal, task: env.GOAL_TASK_ID, command: env.GOAL_QA_COMMAND, startedAt: new Date((options.now ?? Date.now)()).toISOString() } });
  } finally { guard.release(); }
}

/** The harness and dispatcher use the same waiter shape for share admission and status. */
export function slotWaiter(directory: string, env: NodeJS.ProcessEnv, pid: number): { update: () => void; release: () => void } {
  const waiters = join(directory, 'waiters');
  mkdirSync(waiters, { recursive: true });
  const path = join(waiters, `share-${pid}-${crypto.randomUUID()}.json`);
  return {
    update: () => writeFileSync(path, JSON.stringify({ pid, goal: qaGoal(env), task: env.GOAL_TASK_ID,
      command: env.GOAL_QA_COMMAND ?? 'QA', waitingFor: 'slot', since: new Date().toISOString() })),
    release: () => rmSync(path, { force: true }),
  };
}

/** Task routes through this adapter; goalctl remains the owner of command dispatch. */
export function admissionCommand(input: readonly string[]): string[] {
  if (input[0] === '--goalctl') return ['bun', join(import.meta.dir, 'goalctl.ts'), ...input.slice(1)];
  return input[0] === '--' ? input.slice(1) : [...input];
}

/** Validate before reserved admission flags can turn a mixed request into the narrow selection. */
export function borrowedBookSelection(command: readonly string[], heavy = false): boolean {
  if (!command.some(arg => arg.startsWith('--borrowed-public-domain-book'))) return false;
  if (basename(command[0] ?? '') !== 'bun' || resolve(command[1] ?? '') !== resolve(import.meta.dir, '../qa/test.ts'))
    throw new Error('Borrowed Book requires the goalctl test selector');
  if (heavy) throw new Error('Borrowed Book does not accept heavy admission');
  return selectTestGroups(command.slice(2))[0]?.borrowedPublicDomainBook === true;
}

/** The registered worker, including a child in an isolated proof checkout, keeps its real Goal's admission. */
export function borrowedBookAdmission(env: NodeJS.ProcessEnv): { directory: string; workerGoals: () => string[] } {
  const refusal = 'Borrowed Book requires a live registered Goal worker and its shared admission binding';
  if (!env.GOAL_TASK_ID || !env.GOAL_ID || !env.GOAL_WORKTREE || !isAbsolute(env.GOAL_WORKTREE)) throw new Error(refusal);
  if (env.GOAL_IN_SLOT === '1' || env.GOAL_QA_HEAVY_RUN === '1' || env.GOAL_QA_DEFERRED_HEAVY === '1'
    || env.GOAL_QA_HEAVY_LOCK || env.GOAL_QA_HEAVY_LEASE)
    throw new Error('Borrowed Book requires its own ordinary Goal admission, not an inherited slot or heavy run');
  const worktree = realpathSync(env.GOAL_WORKTREE);
  if (realpathSync(git(worktree, ['rev-parse', '--show-toplevel'])) !== worktree) throw new Error(refusal);
  const common = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (resolve(common) === join(worktree, '.git')) throw new Error(refusal); // A proof clone cannot register its own admission.
  const directory = join(dirname(common), '.temp', 'goal-orchestration', 'qa-slots');
  if (!existsSync(directory) || (env.GOAL_QA_SLOT_DIRECTORY && realpathSync(env.GOAL_QA_SLOT_DIRECTORY) !== realpathSync(directory)))
    throw new Error(refusal);
  const workerGoals = () => {
    const ledger = JSON.parse(readFileSync(join(dirname(directory), 'ledger.json'), 'utf8')) as Ledger;
    const task = ledger.tasks[env.GOAL_TASK_ID!];
    const goal = ledger.goals?.[env.GOAL_ID!];
    if (!task || task.id !== env.GOAL_TASK_ID || task.goal !== env.GOAL_ID || !goal || goal.closedAt
      || realpathSync(task.worktree) !== worktree || !task.attempts?.length || !running(task)) throw new Error(refusal);
    return Object.values(ledger.tasks).filter(task => task.state === 'running' && running(task)).map(task => task.goal ?? '?');
  };
  workerGoals();
  return { directory, workerGoals };
}

/** Admit a test selector before it expands the requested plan into commands. */
export async function withTestAdmission(command: string[], heavy = false, resultFile?: string, options: SlotRunOptions = {}): Promise<number> {
  borrowedBookSelection(command, heavy);
  const selector = basename(command[0] ?? '') === 'bun'
    && resolve(command[1] ?? '') === resolve(import.meta.dir, '../qa/test.ts');
  const args = command.slice(2).filter(arg => arg !== '--beside-workers');
  const affected = selector ? (await import('../qa/test.ts')).parseAffectedArgs(args) : undefined;
  // Listing starts neither tests nor a stack, so it must never enter admission.
  if (affected?.list) {
    command = [...command.slice(0, 2), ...args];
    const now = options.now ?? Date.now;
    const queuedAt = now();
    let startedAt: number | undefined;
    let code: number | undefined;
    const start = () => { startedAt = now(); };
    try {
      const env = options.env ?? process.env;
      if (options.runCommand) code = await options.runCommand(command, env, start);
      else {
        const child = Bun.spawn(command, { env, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
        start();
        code = await child.exited;
      }
      return code;
    } finally {
      if (resultFile) {
        const finishedAt = now();
        mkdirSync(dirname(resultFile), { recursive: true });
        writeFileSync(resultFile, JSON.stringify({ code, queuedAt, startedAt, finishedAt,
          queueMs: (startedAt ?? finishedAt) - queuedAt, testMs: startedAt === undefined ? 0 : finishedAt - startedAt,
          totalMs: finishedAt - queuedAt, artifactPaths: [] }, null, 2));
      }
    }
  }
  const { withSlot } = await import('./qa-slots.ts');
  return withSlot(command, heavy, resultFile, options);
}

if (import.meta.main) {
  try {
    const command = admissionCommand(process.argv.slice(2));
    assertWideRunAllowed(command);
    const { withSlot } = await import('./qa-slots.ts');
    if (isWideRun(command)) process.exit(await withSlot(command));
    // Non-QA goalctl commands keep their existing dispatch and ownership.
    const isGoalctl = basename(command[1] ?? '') === 'goalctl.ts';
    if (isGoalctl) {
      const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
      process.exit(await child.exited);
    }
    process.exit(await withTestAdmission(command));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
