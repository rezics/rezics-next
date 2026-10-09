import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** pid, start time and boot id. A reused pid fails the start-time check; a reboot fails the boot id. */
export interface ProcessIdentity {
  pid: number;
  /** Clock ticks since boot, field 22 of /proc/pid/stat. */
  start: string;
  /** /proc/sys/kernel/random/boot_id */
  boot: string;
  cgroup: string;
}

interface ProcessStat {
  state: string;
  parent: number;
  group: number;
  start: string;
}

/** comm may contain spaces and parentheses, so fields start after its final ')'. */
function statFields(pid: number, procRoot: string): string[] | undefined {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const marker = stat.lastIndexOf(')');
    if (marker < 0) return undefined;
    const fields = stat.slice(marker + 2).trim().split(' ');
    return fields.length > 19 ? fields : undefined;
  } catch {
    return undefined;
  }
}

export function readProcessStat(pid: number, procRoot = '/proc'): ProcessStat | undefined {
  if (!Number.isInteger(pid) || pid < 1) return undefined;
  const fields = statFields(pid, procRoot);
  if (!fields) return undefined;
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  const start = fields[19];
  if (!fields[0] || !start || !/^\d+$/.test(start) || !Number.isSafeInteger(parent) || !Number.isSafeInteger(group))
    return undefined;
  return { state: fields[0], parent, group, start };
}

function bootId(procRoot: string): string {
  return readFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim();
}

/** Undefined for a missing process, a zombie, or a task the kernel has already marked dead. */
export function processIdentity(pid: number, procRoot = '/proc'): ProcessIdentity | undefined {
  const stat = readProcessStat(pid, procRoot);
  if (!stat || stat.state === 'Z' || stat.state === 'X') return undefined;
  try {
    return {
      pid, start: stat.start, boot: bootId(procRoot),
      cgroup: readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8').trim(),
    };
  } catch {
    return undefined;
  }
}

export function sameProcess(identity: ProcessIdentity, procRoot = '/proc'): boolean {
  const current = processIdentity(identity.pid, procRoot);
  return current?.start === identity.start && current.boot === identity.boot;
}

/**
 * A live owner. Start time and boot id distinguish a reused pid; without them, only a
 * non-zombie process with that pid counts. Signal 0 is not enough: a zombie still accepts it.
 */
export function processAlive(identity: { pid: number; start?: string; boot?: string }, procRoot = '/proc'): boolean {
  if (identity.start !== undefined && identity.boot !== undefined) {
    const current = processIdentity(identity.pid, procRoot);
    return current?.start === identity.start && current.boot === identity.boot;
  }
  return processIdentity(identity.pid, procRoot) !== undefined;
}

/** Start time of a live process. A zombie or a dead task has none: it cannot own a lease. */
export function processStartTime(pid: number, procRoot = '/proc'): string | undefined {
  const stat = readProcessStat(pid, procRoot);
  if (!stat || stat.state === 'Z' || stat.state === 'X') return undefined;
  return stat.start;
}

export function processParent(pid: number, procRoot = '/proc'): number | undefined {
  return readProcessStat(pid, procRoot)?.parent;
}

export function processGroup(pid: number, procRoot = '/proc'): number | undefined {
  return readProcessStat(pid, procRoot)?.group;
}

/** The pid itself, then each ancestor. Stops at pid 1 or a cycle. */
export function processAncestors(pid: number, procRoot = '/proc'): number[] {
  const found: number[] = [];
  for (let current = pid; current > 1 && !found.includes(current);) {
    found.push(current);
    const parent = processParent(current, procRoot);
    if (parent === undefined) break;
    current = parent;
  }
  return found;
}
