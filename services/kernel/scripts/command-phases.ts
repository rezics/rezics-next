import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Command phases owned by Kernel. Slot wait and rsync stay on the transport receipt. */
export const KERNEL_COMMAND_PHASES = ['database-image', 'migrations', 'sql-schema', 'compiler', 'cleanup'] as const;

export type KernelCommandPhase = (typeof KERNEL_COMMAND_PHASES)[number];

export type CommandPhaseClock = () => bigint;

export type SliceMemory = {
  anon?: number;
  file?: number;
  inactive_file?: number;
};

export type IoPressure = {
  someAvg10?: number;
  fullAvg10?: number;
};

export type CommandObservation = {
  source?: string;
  command: string[];
  concurrency: number;
  memory?: SliceMemory;
  io?: IoPressure;
};

const PHASE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

export function appendCommandPhase(
  phase: string,
  edge: 'start' | 'end',
  env: NodeJS.ProcessEnv = process.env,
  nowNs: CommandPhaseClock = () => process.hrtime.bigint(),
): void {
  const file = env.REZICS_CHECK_PHASES;
  if (!file || !PHASE_NAME.test(phase) || (edge !== 'start' && edge !== 'end')) return;
  try {
    appendFileSync(file, `${phase}\t${edge}\t${nowNs().toString()}\n`);
  } catch {
    // Observation must not fail SQL-mapped compilation.
  }
}

export async function withCommandPhase<T>(
  phase: string,
  work: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
  nowNs: CommandPhaseClock = () => process.hrtime.bigint(),
): Promise<T> {
  appendCommandPhase(phase, 'start', env, nowNs);
  try {
    return await work();
  } finally {
    appendCommandPhase(phase, 'end', env, nowNs);
  }
}

export function parseMemoryStat(contents: string): SliceMemory {
  const memory: SliceMemory = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^(anon|file|inactive_file) (\d+)$/);
    if (match) memory[match[1] as keyof SliceMemory] = Number(match[2]);
  }
  return memory;
}

export function parseIoPressure(contents: string): IoPressure {
  const io: IoPressure = {};
  const some = contents.match(/^some avg10=([0-9.]+)/m);
  const full = contents.match(/^full avg10=([0-9.]+)/m);
  if (some) io.someAvg10 = Number(some[1]);
  if (full) io.fullAvg10 = Number(full[1]);
  return io;
}

export function readSliceMemory(statPath: string): SliceMemory | undefined {
  try {
    const memory = parseMemoryStat(readFileSync(statPath, 'utf8'));
    return memory.anon !== undefined || memory.file !== undefined || memory.inactive_file !== undefined
      ? memory
      : undefined;
  } catch {
    return undefined;
  }
}

export function readIoPressure(path: string): IoPressure | undefined {
  try {
    const io = parseIoPressure(readFileSync(path, 'utf8'));
    return io.someAvg10 !== undefined || io.fullAvg10 !== undefined ? io : undefined;
  } catch {
    return undefined;
  }
}

function cgroupDirectory(): string | undefined {
  try {
    const match = readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.+)$/m);
    return match ? `/sys/fs/cgroup${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

export function sourceIdentity(repository: string): string | undefined {
  const result = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const source = result.stdout.trim();
  return result.status === 0 && /^[0-9a-f]{40}$/.test(source) ? source : undefined;
}

export function commandObservation(
  command: string[],
  repository: string,
  env: NodeJS.ProcessEnv = process.env,
  cgroup = cgroupDirectory(),
): CommandObservation {
  const concurrency = Number(env.KERNEL_CHECK_CONCURRENCY);
  const observation: CommandObservation = {
    command,
    concurrency: Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1,
  };
  const source = sourceIdentity(repository);
  if (source) observation.source = source;
  if (cgroup) {
    const memory = readSliceMemory(`${cgroup}/memory.stat`);
    if (memory) observation.memory = memory;
    const io = readIoPressure(`${cgroup}/io.pressure`);
    if (io) observation.io = io;
  }
  return observation;
}

export function formatCommandObservation(label: string, observation: CommandObservation): string {
  const parts = [
    `${label} observation`,
    observation.source ? `source=${observation.source}` : 'source=unavailable',
    `command=${observation.command.join(' ')}`,
    `concurrency=${observation.concurrency}`,
  ];
  if (observation.memory?.anon !== undefined) parts.push(`anon=${observation.memory.anon}`);
  if (observation.memory?.file !== undefined) parts.push(`file=${observation.memory.file}`);
  if (observation.memory?.inactive_file !== undefined) parts.push(`inactive_file=${observation.memory.inactive_file}`);
  if (observation.io?.someAvg10 !== undefined) parts.push(`io.some.avg10=${observation.io.someAvg10}`);
  if (observation.io?.fullAvg10 !== undefined) parts.push(`io.full.avg10=${observation.io.fullAvg10}`);
  return `${parts.join(' ')}\n`;
}

export function writeCommandObservation(
  label: string,
  observation: CommandObservation,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!env.REZICS_CHECK_PHASES) return;
  process.stderr.write(formatCommandObservation(label, observation));
}
