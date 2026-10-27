/**
 * Places a stack-heavy run: on a development check host when one of its slots is free right now, otherwise under the
 * local stack lease (`stack-lease.ts`), exactly as before. It never waits for a host and never races the two.
 *
 * The run stays local when
 * - KERNEL_CHECK_REMOTE names no readable hosts file, or REZICS_STACK_REMOTE=off;
 * - it already runs on a check host (KERNEL_CHECK_ON_REMOTE, REZICS_STACK_LEASE=off) or inside a slot
 *   (an inherited REZICS_STACK_SLOT);
 * - the caller says it writes files the caller keeps: nothing is copied back from a host.
 *
 * A host runs the same command in a copy of the workspace, with the caller's environment left behind. One line on
 * stderr says where the run went and why.
 */
import { accessSync, constants } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Aborted, readHosts, tryRemoteCheck } from './remote-check.ts';
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

function localReason(run: StackRun, env: Environment): string | { hostsFile: string } {
  if (env.REZICS_STACK_REMOTE === 'off') return 'REZICS_STACK_REMOTE=off';
  if (env.KERNEL_CHECK_ON_REMOTE || env.REZICS_STACK_LEASE === 'off') return 'already on a check host';
  if (env.REZICS_STACK_SLOT !== undefined) return 'already inside a stack slot';
  if (run.keepsFiles) return 'the run keeps files it writes';
  const inside = relative(resolve(run.root), resolve(run.cwd));
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
    return 'the directory is outside the workspace';
  const hostsFile = env.KERNEL_CHECK_REMOTE;
  if (!hostsFile) return 'no check host is configured';
  try {
    accessSync(hostsFile, constants.R_OK);
  } catch {
    return `the hosts file ${hostsFile} is not readable`;
  }
  return { hostsFile };
}

/**
 * Runs the command on a check host with a free slot and returns its exit code, or returns null when the run belongs
 * on this machine. The null is a placement, never an exit code.
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
  try {
    const outcome = await tryRemoteCheck(
      {
        hosts: readHosts(reason.hostsFile),
        workspace: run.root,
        cwd: relative(resolve(run.root), resolve(run.cwd)) || '.',
        command: run.command,
        ...(run.slots === undefined ? {} : { slots: run.slots }),
        started: (host) => {
          started = true;
          console.error(`stack-run: ${run.label} on ${host}`);
        },
      },
      controller.signal,
    );
    if (outcome.status === 'ran') return outcome.code;
    console.error(`stack-run: ${run.label} local, every check host slot busy`);
    return null;
  } catch (error) {
    if (error instanceof Aborted) return 128 + (received ?? 15);
    if (started) throw error;
    // Nothing has run yet, so the local lease is still a safe place for the command.
    console.error(`stack-run: ${run.label} local, ${error instanceof Error ? error.message : error}`);
    return null;
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
}

/** The one place a stack-heavy run is placed: on a free check host slot, or `local` under the local lease. */
export async function stackRun(
  run: StackRun,
  local: (env: Record<string, string>) => Promise<number>,
  env: Environment = process.env,
): Promise<number> {
  return (await runOnCheckHost(run, env)) ?? (await withStackSlot(run.label, local));
}

if (import.meta.main) {
  const usage = 'Usage: bun scripts/stack-run.ts [--keeps-files] [--slots <n>] <label> <root> <cwd> -- <command...>';
  const rest = process.argv.slice(2);
  let keepsFiles = false;
  let slots: number | undefined;
  while (rest[0]?.startsWith('--') && rest[0] !== '--') {
    const flag = rest.shift();
    if (flag === '--keeps-files') keepsFiles = true;
    else if (flag === '--slots' && rest.length > 0) slots = Number(rest.shift());
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
