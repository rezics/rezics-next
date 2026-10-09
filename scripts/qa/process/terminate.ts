import { readdirSync } from 'node:fs';
import { processAncestors, processGroup, readProcessStat } from './identity.ts';

/** A child that ignores SIGTERM is killed after this. */
export const defaultStopGraceMs = 1_000;

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

/**
 * Registered groups plus every descendant group visible now. A later walk cannot
 * see a group whose parent exited during the grace and was reparented.
 */
export function descendantProcessGroups(roots: ReadonlySet<number>, procRoot = '/proc'): Set<number> {
  const groups = new Set(roots);
  let entries: string[];
  try { entries = readdirSync(procRoot); }
  catch { return groups; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const group = processGroup(pid, procRoot);
    if (!group || groups.has(group)) continue;
    if (processAncestors(pid, procRoot).some(ancestor => roots.has(ancestor))) groups.add(group);
  }
  return groups;
}

/** A group outlives its leader. Membership, not the leader pid, is what is still running. */
function groupsHaveLiveMember(groups: ReadonlySet<number>, procRoot: string): boolean {
  let entries: string[];
  try { entries = readdirSync(procRoot); }
  catch { return false; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readProcessStat(Number(entry), procRoot);
    if (!stat || stat.state === 'Z' || stat.state === 'X') continue;
    if (groups.has(stat.group)) return true;
  }
  return false;
}

/**
 * Freeze the tree, then SIGKILL from the leaves. SIGSTOP closes the window in which
 * a child can fork another command between discovery and shutdown.
 */
export function killProcessGroups(roots: ReadonlySet<number>, procRoot = '/proc'): void {
  if (!roots.size) return;
  const frozen = new Set<number>();
  const freeze = (group: number) => {
    frozen.add(group);
    try { process.kill(-group, 'SIGSTOP'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  for (const pid of roots) freeze(pid);
  const descendants = new Map<number, { pid: number; group: number; depth: number }>();
  let entries: string[] = [];
  try { entries = readdirSync(procRoot); } catch { /* /proc is gone */ }
  let discovered: boolean;
  do {
    discovered = false;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const stat = readProcessStat(pid, procRoot);
      if (!stat) continue;
      const depth = processAncestors(pid, procRoot).findIndex(ancestor => roots.has(ancestor));
      if (depth < 0) continue;
      descendants.set(pid, { pid, group: stat.group, depth });
      if (!frozen.has(stat.group)) { freeze(stat.group); discovered = true; }
    }
    if (discovered) {
      try { entries = readdirSync(procRoot); } catch { entries = []; }
    }
  } while (discovered);
  for (const { pid, group } of [...descendants.values()].sort((left, right) => right.depth - left.depth)) {
    try { process.kill(pid === group ? -pid : pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  for (const pid of roots) {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}

function waitSync(groups: ReadonlySet<number>, budgetMs: number, procRoot: string): void {
  const deadline = Date.now() + budgetMs;
  while (groupsHaveLiveMember(groups, procRoot) && Date.now() < deadline) {
    const remaining = Math.min(50, Math.max(1, deadline - Date.now()));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
  }
}

async function waitAsync(groups: ReadonlySet<number>, budgetMs: number, procRoot: string,
  sleep: (ms: number) => Promise<void>): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && groupsHaveLiveMember(groups, procRoot)) {
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

export interface TerminateProcessGroupOptions {
  graceMs?: number;
  /** Bound on the wait after SIGKILL. Defaults to the grace. */
  killWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  procRoot?: string;
}

/**
 * SIGTERM the process group, then SIGKILL if it is still alive after the grace.
 * Resolves only once the snapshotted groups are gone or the post-KILL wait elapses.
 * Callers release slots and queue tickets after this returns.
 */
export async function terminateProcessGroup(pid: number, options: TerminateProcessGroupOptions = {}): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const procRoot = options.procRoot ?? '/proc';
  const graceMs = options.graceMs ?? defaultStopGraceMs;
  const killWaitMs = options.killWaitMs ?? graceMs;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const groups = descendantProcessGroups(new Set([pid]), procRoot);
  for (const group of groups) signalProcessGroup(group, 'SIGTERM');
  await waitAsync(groups, graceMs, procRoot, sleep);
  if (groupsHaveLiveMember(groups, procRoot)) {
    killProcessGroups(groups, procRoot);
    await waitAsync(groups, killWaitMs, procRoot, sleep);
  }
}

/** Signal-handler form. A zero grace skips SIGTERM and kills immediately, then waits out the bound. */
export function terminateProcessGroupSync(pid: number, graceMs: number, procRoot = '/proc'): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const groups = descendantProcessGroups(new Set([pid]), procRoot);
  if (graceMs > 0) {
    for (const group of groups) signalProcessGroup(group, 'SIGTERM');
    waitSync(groups, graceMs, procRoot);
  }
  if (graceMs === 0 || groupsHaveLiveMember(groups, procRoot))
    killProcessGroups(groups, procRoot);
  waitSync(groups, Math.max(graceMs, defaultStopGraceMs), procRoot);
}
