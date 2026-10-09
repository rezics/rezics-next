import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { GiB, isLocalQaRun, qaMemoryDeadline, qaMemoryNeed, waitForMemory,
  type MemoryReading } from './memory-admission.ts';
import { defaultStopGraceMs, terminateProcessGroup } from './process/terminate.ts';

export const hostAdmissionUsage = 'Usage: bun scripts/qa/host-admission.ts --gib <need> -- <command...>';

const gibPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function parseHostAdmissionArgs(args: readonly string[]): { gib: number; command: string[] } {
  const split = args.indexOf('--');
  if (args[0] !== '--gib' || split !== 2 || split >= args.length - 1) throw new Error(hostAdmissionUsage);
  if (!gibPattern.test(args[1] ?? '') || Number(args[1]) <= 0)
    throw new Error('--gib must be a positive number of gibibytes');
  return { gib: Number(args[1]), command: args.slice(split + 1) };
}

export interface HostAdmissionOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  deadline?: number;
  read?: (remainingMs: number) => Promise<MemoryReading>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  announce?: (message: string) => void;
  pollMs?: number;
  run?: (command: readonly string[]) => Promise<number>;
}

async function spawnInherited(command: readonly string[]): Promise<number> {
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: 'inherit' });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  let stopping: Promise<void> | undefined;
  const forward = () => {
    if (!child.pid) return;
    stopping ??= terminateProcessGroup(child.pid, { graceMs: defaultStopGraceMs });
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    const code = await exited;
    if (stopping) await stopping;
    return code;
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

/** Wait until the host keeps its reserve after `gib` GiB, then run the command.
 * Outside a local Goal run, only the command runs. */
export async function runHostAdmission(gib: number, command: readonly string[],
  options: HostAdmissionOptions = {}): Promise<number> {
  if (!Number.isFinite(gib) || gib <= 0) throw new Error('--gib must be a positive number of gibibytes');
  if (command.length === 0) throw new Error(hostAdmissionUsage);
  const env = options.env ?? process.env;
  const root = options.root ?? resolve(import.meta.dir, '../..');
  const run = options.run ?? spawnInherited;
  if (!await isLocalQaRun(root, env)) return await run(command);
  const reserve = qaMemoryNeed(root, 'other', undefined, env).hostReserve;
  await waitForMemory({ vm: 0, vmReserve: 0, host: gib * GiB, hostReserve: reserve }, {
    root, env, deadline: options.deadline ?? qaMemoryDeadline(env),
    read: options.read, now: options.now, sleep: options.sleep, announce: options.announce, pollMs: options.pollMs,
  });
  return await run(command);
}

if (import.meta.main) {
  try {
    const parsed = parseHostAdmissionArgs(process.argv.slice(2));
    process.exit(await runHostAdmission(parsed.gib, parsed.command));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
