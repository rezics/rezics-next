/**
 * Places a stack-heavy run. On a check host means the working directory is under the remote run root
 * (`ROOT/runs/` in `remote-check.ts`). With a readable hosts file and a host that answers, the run waits for a slot.
 * It runs locally only when no host answers, and says so on stderr. A local run then takes the stack lease
 * (`stack-lease.ts`).
 *
 * The hosts file is KERNEL_CHECK_REMOTE when that name is non-empty, otherwise the shared file
 * `<main checkout>/.temp/goal/remote-check-hosts.json` when it is readable. The main checkout is the parent of
 * `git rev-parse --git-common-dir`. A run that keeps files it writes stays local unless it declares workspace-relative
 * paths to copy back.
 *
 * A person (GOAL_TASK_ID unset or empty) can keep a run local with REZICS_STACK_REMOTE=off or an inherited
 * REZICS_STACK_SLOT. A worker cannot. KERNEL_CHECK_ON_REMOTE and REZICS_STACK_LEASE never decide placement.
 * KERNEL_CHECK_ON_REMOTE and REZICS_STACK_LEASE never decide placement.
 *
 * A host runs the same command in a copy of the workspace, with the caller's environment left behind. Stderr says
 * where the run went, and when it is waiting.
 */
import { accessSync, constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Aborted, answeringHosts, readHosts, remoteCheckUnlessUnreachable, ROOT } from './remote-check.ts';
import { withStackSlot } from './stack-lease.ts';

export type StackRun = {
  label: string;
  /** The workspace root; the whole checkout is copied to the host. */
  root: string;
  /** The directory the command runs in, inside the root. */
  cwd: string;
  command: string[];
  /** Host slots the run holds, for a run whose peak memory exceeds a host's per-slot share. Default 1. */
  slots?: number;
  /** The run writes files the caller keeps (updated snapshots, recordings, reports), so it must stay local. */
  keepsFiles?: boolean;
  /**
   * Workspace-relative paths copied back after the run, including when it fails. Declaring them means the run does
   * not stay local for the files it writes.
   */
  returns?: string[];
};

type Environment = Record<string, string | undefined>;

const SIGNALS = [
  ['SIGINT', 2],
  ['SIGTERM', 15],
  ['SIGHUP', 1],
] as const;

/** `bun test` options that write files the caller reads or keeps, or that need the caller's Git state. */
const KEEPING_OPTIONS =
  /^(?:--reporter-outfile|--coverage(?:-dir)?|--update-snapshots|-u|--changed|--watch|--hot)(?:=|$)/;

/** Whether the arguments of a `bun test` run ask for files kept on the caller's machine. */
export function testKeepsFiles(args: string[]): boolean {
  return args.some((argument) => KEEPING_OPTIONS.test(argument));
}

const SHARED_HOSTS = join('.temp', 'goal', 'remote-check-hosts.json');

/** A worker carries a task id. An unset or empty id is a person, who may still opt out of a remote run. */
export function isWorker(env: Environment): boolean {
  return Boolean(env.GOAL_TASK_ID);
}

/** The working directory is inside a check host's run directory. Environment variables do not count. */
export function onCheckHost(cwd: string): boolean {
  const runs = join(ROOT, 'runs');
  const inside = relative(runs, resolve(cwd));
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/** Parent of `git rev-parse --git-common-dir` for `root`, or null when `root` is not a checkout. */
export function mainCheckout(root: string): string | null {
  const result = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) return null;
  const common = result.stdout.toString().trim();
  return common ? dirname(common) : null;
}

function readable(file: string): boolean {
  try {
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * KERNEL_CHECK_REMOTE when it is non-empty, otherwise the shared hosts file under the main checkout when that file
 * can be read. A non-empty name that cannot be read does not fall back.
 */
export function hostsLocation(root: string, env: Environment): { file: string } | { reason: string } {
  const named = env.KERNEL_CHECK_REMOTE;
  if (named) {
    return readable(named) ? { file: named } : { reason: `the hosts file ${named} is not readable` };
  }
  const main = mainCheckout(root);
  const shared = main ? join(main, SHARED_HOSTS) : undefined;
  if (shared && readable(shared)) return { file: shared };
  return { reason: 'no check host is configured' };
}

export const LOCAL_CONTAINER_REFUSAL =
  'A worker cannot start a local stack container while a check host is reachable. ' +
  'Hand the run to `bun run --cwd services/kernel check <files>`, ' +
  '`bun run --cwd services/auth check <files>`, or root `bun test`.';

/**
 * The error a worker must see instead of starting a local stack container, or null when this start may proceed:
 * a person, a run already on a check host, or no check host answering.
 */
export async function workerLocalContainerError(env: Environment, cwd: string): Promise<string | null> {
  if (!isWorker(env) || onCheckHost(cwd)) return null;
  const located = hostsLocation(cwd, env);
  if (!('file' in located)) return null;
  try {
    if ((await answeringHosts(readHosts(located.file))).length === 0) return null;
  } catch {
    return null;
  }
  return LOCAL_CONTAINER_REFUSAL;
}

function pollMs(env: Environment): number | undefined {
  const value = env.REMOTE_CHECK_POLL_MS;
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function localReason(run: StackRun, env: Environment): string | { hostsFile: string } {
  if (onCheckHost(run.cwd)) return 'already on a check host';
  if (!isWorker(env) && env.REZICS_STACK_REMOTE === 'off') return 'REZICS_STACK_REMOTE=off';
  if (!isWorker(env) && env.REZICS_STACK_SLOT !== undefined) return 'already inside a stack slot';
  if (run.keepsFiles && run.returns === undefined) return 'the run keeps files it writes';
  const inside = relative(resolve(run.root), resolve(run.cwd));
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
    return 'the directory is outside the workspace';
  const located = hostsLocation(run.root, env);
  if ('reason' in located) return located.reason;
  return { hostsFile: located.file };
}

/**
 * Runs the command on a check host and returns its exit code, waiting for a slot when a host answers. Returns null
 * when the run belongs on this machine. The null is a placement, never an exit code.
 */
export async function runOnCheckHost(run: StackRun, env: Environment = process.env): Promise<number | null> {
  const reason = localReason(run, env);
  if (typeof reason === 'string') {
    console.error(`stack-run: ${run.label} local, ${reason}`);
    return null;
  }
  const controller = new AbortController();
  let received: number | undefined;
  const handlers = SIGNALS.map(([name, number]) => {
    const handler = () => {
      received ??= number;
      controller.abort();
    };
    process.on(name, handler);
    return [name, handler] as const;
  });
  let started = false;
  let answered = false;
  try {
    const interval = pollMs(env);
    const outcome = await remoteCheckUnlessUnreachable(
      {
        hosts: readHosts(reason.hostsFile),
        workspace: run.root,
        cwd: relative(resolve(run.root), resolve(run.cwd)) || '.',
        command: run.command,
        ...(run.slots === undefined ? {} : { slots: run.slots }),
        ...(interval === undefined ? {} : { pollMs: interval }),
        ...(run.returns === undefined ? {} : { returns: run.returns }),
        answered: () => {
          answered = true;
        },
        started: (host) => {
          started = true;
          console.error(`stack-run: ${run.label} on ${host}`);
        },
      },
      controller.signal,
    );
    if (outcome === null) {
      console.error(`stack-run: ${run.label} local, no check host answered`);
      return null;
    }
    return outcome;
  } catch (error) {
    if (error instanceof Aborted) return 128 + (received ?? 15);
    if (answered || started) throw error;
    // Only an unanswered host probe is a local placement; do not bypass a reachable host after another error.
    console.error(`stack-run: ${run.label} local, ${error instanceof Error ? error.message : error}`);
    return null;
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
}

/** The one place a stack-heavy run is placed: on a check host, waiting for a slot, or `local` under the local lease. */
export async function stackRun(
  run: StackRun,
  local: (env: Record<string, string>) => Promise<number>,
  env: Environment = process.env,
): Promise<number> {
  return (await runOnCheckHost(run, env)) ?? (await withStackSlot(run.label, local));
}

if (import.meta.main) {
  const usage =
    'Usage: bun scripts/stack-run.ts [--keeps-files] [--returns <path>]... [--slots <n>] <label> <root> <cwd> -- <command...>';
  const rest = process.argv.slice(2);
  let keepsFiles = false;
  let slots: number | undefined;
  let returns: string[] | undefined;
  while (rest[0]?.startsWith('--') && rest[0] !== '--') {
    const flag = rest.shift();
    if (flag === '--keeps-files') keepsFiles = true;
    else if (flag === '--returns' && rest.length > 0) {
      returns ??= [];
      returns.push(rest.shift()!);
    } else if (flag === '--slots' && rest.length > 0) slots = Number(rest.shift());
    else throw new Error(`Unknown option: ${flag}\n${usage}`);
  }
  const [label, root, cwd, separator, ...command] = rest;
  if (!label || !root || !cwd || separator !== '--' || command.length === 0) {
    console.error(usage);
    process.exitCode = 2;
  } else if (slots !== undefined && (!Number.isSafeInteger(slots) || slots < 1)) {
    console.error(`--slots must be a positive integer\n${usage}`);
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await stackRun(
        {
          label,
          root: resolve(root),
          cwd: resolve(cwd),
          command,
          keepsFiles,
          ...(returns === undefined ? {} : { returns }),
          ...(slots === undefined ? {} : { slots }),
        },
        async (env) => {
          const child = Bun.spawn(command, {
            cwd: resolve(cwd),
            env: { ...process.env, ...env },
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
          });
          // Until here a signal ends this process by default, which is right while it waits and while a host runs it.
          const forwarders = SIGNALS.map(([name]) => {
            const forward = () => child.kill(name);
            process.on(name, forward);
            return [name, forward] as const;
          });
          try {
            return await child.exited;
          } finally {
            for (const [name, forward] of forwarders) process.off(name, forward);
          }
        },
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
