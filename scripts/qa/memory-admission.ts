import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { qaResourceClasses, type QaResourceClass } from './resource-classes.ts';

export const GiB = 1024 ** 3;
export interface MemoryReading { vmTotal: number; vmUsed: number; hostAvailable: number }
export interface MemoryNeed { vm: number; host: number; hostReserve: number; vmReserve: number }

/** Stats uses SI or IEC units; Docker container caps interpret every suffix as binary. */
export function memoryBytes(value: string, containerCap = false): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|m|g|t|kb|mb|gb|tb|kib|mib|gib|tib)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid memory size: ${value}`);
  const unit = (match[2] ?? 'b').toLowerCase();
  const power = unit === 'b' ? 0 : 'kmgt'.indexOf(unit[0]!) + 1;
  const base = !containerCap && unit.length === 2 ? 1000 : 1024;
  const bytes = Number(match[1]) * base ** power;
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`Invalid memory size: ${value}`);
  return bytes;
}

function threshold(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value < 0 || env[name]?.trim() === '')
    throw new Error(`${name} must be a nonnegative number`);
  return value;
}

/** Read the authored caps so changes to Compose cannot silently underbudget QA. */
export function qaMemoryNeed(root: string, kind: 'other' | 'browser', resourceClass?: QaResourceClass,
  env: NodeJS.ProcessEnv = process.env): MemoryNeed {
  let vm = 0;
  if (resourceClass) {
    const capBytes = (value: string) => {
      const bytes = memoryBytes(value, true);
      if (bytes === 0) throw new Error('Memory admission requires finite, positive QA container caps');
      return bytes;
    };
    const compose = readFileSync(join(root, 'infra/dev/compose.qa.yaml'), 'utf8');
    for (const service of ['POSTGRES', 'RUSTFS', 'TOXIPROXY', 'MAILPIT']) {
      const key = `REZICS_${service}_MEMORY_LIMIT`;
      const cap = new RegExp(`\\$\\{${key}:-([^}]+)\\}`).exec(compose)?.[1];
      if (!cap) throw new Error(`Missing QA memory cap: ${key}`);
      vm += capBytes(env[key] ?? cap);
    }
    vm += capBytes(env.REZICS_FUSEKI_MEMORY_LIMIT ?? env.REZICS_QA_FUSEKI_MEMORY_LIMIT
      ?? qaResourceClasses[resourceClass].memory);
  }
  return {
    vm, host: threshold(env, kind === 'browser' ? 'REZICS_QA_BROWSER_MEMORY_GIB' : 'REZICS_QA_HOST_MEMORY_GIB',
      kind === 'browser' ? 4 : 1) * GiB,
    hostReserve: threshold(env, 'REZICS_QA_HOST_RESERVE_GIB', 8) * GiB,
    vmReserve: threshold(env, 'REZICS_QA_VM_RESERVE_GIB', 0) * GiB,
  };
}

export function parseMemoryReading(total: string, stats: string, meminfo: string): MemoryReading {
  const vmTotal = Number(total.trim());
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);
  if (!Number.isSafeInteger(vmTotal) || vmTotal <= 0 || !available)
    throw new Error('Cannot read Docker VM total or host MemAvailable');
  const vmUsed = stats.trim() ? stats.trim().split('\n').reduce((sum, line) => {
    const row = JSON.parse(line) as { MemUsage?: string };
    if (!row.MemUsage) throw new Error('Docker stats did not report container memory');
    return sum + memoryBytes(row.MemUsage.split('/')[0]!);
  }, 0) : 0;
  return { vmTotal, vmUsed, hostAvailable: Number(available[1]) * 1024 };
}

const execute = promisify(execFile);
export async function readMemory(remainingMs: number): Promise<MemoryReading> {
  const timeout = Math.max(1, Math.min(10_000, remainingMs));
  const [info, stats] = await Promise.all([
    execute('docker', ['info', '--format', '{{.MemTotal}}'], { timeout }),
    execute('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout, maxBuffer: 4 * 1024 ** 2 }),
  ]);
  return parseMemoryReading(info.stdout, stats.stdout, readFileSync('/proc/meminfo', 'utf8'));
}

export interface MemoryWaitOptions {
  deadline: number;
  read?: (remainingMs: number) => Promise<MemoryReading>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  announce?: (message: string) => void;
  pollMs?: number;
}

function admissionMessage(need: MemoryNeed, reading?: MemoryReading): string {
  const gib = (bytes: number) => `${(bytes / GiB).toFixed(2)} GiB`;
  return `QA memory: Docker VM needs ${gib(need.vm)} + ${gib(need.vmReserve)} reserve, `
    + `free ${reading ? gib(Math.max(0, reading.vmTotal - reading.vmUsed)) : 'unknown'}; `
    + `host needs ${gib(need.host)} + ${gib(need.hostReserve)} reserve, `
    + `available ${reading ? gib(reading.hostAvailable) : 'unknown'}`;
}

/** A slot authorizes concurrency; only a fresh measured reading admits the work. */
export async function waitForMemory(need: MemoryNeed, options: MemoryWaitOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const announce = options.announce ?? console.log;
  const read = options.read ?? readMemory;
  const pollMs = options.pollMs ?? threshold(process.env, 'REZICS_QA_MEMORY_POLL_MS', 3_000);
  if (pollMs <= 0) throw new Error('REZICS_QA_MEMORY_POLL_MS must be positive');
  let message = admissionMessage(need);
  for (;;) {
    if (now() >= options.deadline) throw new Error(`Memory admission deadline reached; ${message}; no work started`);
    let reading: MemoryReading;
    try {
      reading = await read(options.deadline - now());
      if (Object.values(reading).some(value => !Number.isFinite(value) || value < 0) || reading.vmTotal === 0)
        throw new Error('Invalid memory reading');
      message = admissionMessage(need, reading);
      if (now() < options.deadline && reading.vmTotal - reading.vmUsed >= need.vm + need.vmReserve
        && reading.hostAvailable >= need.host + need.hostReserve) {
        announce(`Admitted; ${message}`);
        return;
      }
    } catch (error) {
      message = `${admissionMessage(need)}; measurement failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    announce(`Waiting; ${message}`);
    if (now() >= options.deadline) throw new Error(`Memory admission deadline reached; ${message}; no work started`);
    await sleep(Math.min(pollMs, options.deadline - now()));
  }
}
