import type { Database } from 'bun:sqlite';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultPolicy } from './policy.ts';

export type ContainerPolicy = { maxAgeHours: number; keep: string[] };
export type ContainerRow = { id: string; name: string; createdMs: number };

const execFileAsync = promisify(execFile);
const LIST_FORMAT = '{{.ID}}\t{{.Names}}\t{{.CreatedAt}}';

function normalizePolicy(value: unknown, defaults = defaultPolicy.containers): ContainerPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'maxAgeHours' && key !== 'keep')) return undefined;
  const maxAgeHours = raw.maxAgeHours === undefined ? defaults.maxAgeHours : raw.maxAgeHours;
  const keep = raw.keep === undefined ? [] : raw.keep;
  if (typeof maxAgeHours !== 'number' || !Number.isFinite(maxAgeHours) || maxAgeHours < 0) return undefined;
  if (!Array.isArray(keep) || keep.some((prefix) => typeof prefix !== 'string' || prefix.length === 0))
    return undefined;
  return { maxAgeHours, keep: keep as string[] };
}

function docker(args: string[], policy: typeof defaultPolicy.containers) {
  try {
    return spawnSync('docker', args, { encoding: 'utf8', timeout: policy.commandTimeoutMs });
  } catch {
    return undefined;
  }
}

/**
 * Docker on the host's reaper path runs asynchronously: a slow daemon (btrfs maintenance held it past 120 s on
 * 2026-11-05) must never hold the manager socket or the scheduler. A failed command reports its partial stdout.
 */
async function dockerAsync(
  args: string[],
  policy: typeof defaultPolicy.containers,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('docker', args, { encoding: 'utf8', timeout: policy.commandTimeoutMs });
    return { ok: true, stdout };
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return { ok: false, stdout: typeof stdout === 'string' ? stdout : '' };
  }
}

/**
 * Containers a worker or a check started and left running: older than the policy's age, not kept by a name prefix
 * and not named after a running task. Leaked test databases held about 10 GiB of this host on 2026-10-27.
 */
export function staleContainers(
  rows: readonly ContainerRow[],
  policy: ContainerPolicy,
  running: readonly string[],
  now: number,
): string[] {
  const validPolicy = normalizePolicy(policy);
  if (!validPolicy) return [];
  const maxAgeMs = validPolicy.maxAgeHours * 3_600_000; // Hours to milliseconds.
  return rows
    .filter((row) => now - row.createdMs >= maxAgeMs)
    .filter((row) => !validPolicy.keep.some((prefix) => row.name.startsWith(prefix)))
    .filter((row) => !running.some((taskId) => row.name.includes(taskId.slice(0, 8))))
    .map((row) => row.id);
}

function confirmedRemovals(stdout: string, selected: readonly ContainerRow[]): number {
  const confirmations = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return selected.filter((row) => confirmations.has(row.id) || confirmations.has(row.name)).length;
}

/** The policy in `<state>/containers.json`; a missing or invalid file removes nothing. */
function containerPolicy(
  stateDirectory: string,
  defaults: typeof defaultPolicy.containers,
): ContainerPolicy | undefined {
  const file = join(stateDirectory, 'containers.json');
  if (!existsSync(file)) return undefined;
  let policyValue: unknown;
  try {
    policyValue = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  return normalizePolicy(policyValue, defaults);
}

function listedRows(stdout: string): ContainerRow[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id = '', name = '', created = ''] = line.split('\t');
      // Docker prints "2026-10-27 21:50:54 +0800 CST".
      const [date, time, zone = '+0000'] = created.split(' ');
      return { id, name, createdMs: Date.parse(`${date}T${time}${zone.slice(0, 3)}:${zone.slice(3, 5)}`) };
    })
    .filter((row) => row.id && Number.isFinite(row.createdMs));
}

/** Task IDs with a running attempt, read from the indexed current-attempt table instead of every attempt body. */
function runningTaskIds(db: Database): string[] {
  return (
    db.query("SELECT task_id FROM worker_current_attempts WHERE attempt_state = 'running'").all() as {
      task_id: string;
    }[]
  ).map((row) => row.task_id);
}

function staleRemovals(rows: ContainerRow[], policy: ContainerPolicy, db: Database, now: number): ContainerRow[] {
  const ids = new Set(staleContainers(rows, policy, runningTaskIds(db), now));
  return rows.filter((row) => ids.has(row.id));
}

/** Removes stale containers when `<state>/containers.json` sets a policy; a host without it removes nothing. */
export function reapContainers(
  db: Database,
  stateDirectory: string,
  now = Date.now(),
  defaults = defaultPolicy.containers,
): number {
  const policy = containerPolicy(stateDirectory, defaults);
  if (!policy) return 0;
  const listed = docker(['ps', '--format', LIST_FORMAT], defaults);
  if (!listed || listed.error || listed.status !== 0 || typeof listed.stdout !== 'string') return 0;
  const selected = staleRemovals(listedRows(listed.stdout), policy, db, now);
  if (!selected.length) return 0;
  const staleIds = selected.map((row) => row.id);
  const removed = docker(['rm', '-f', '-v', ...staleIds], defaults);
  if (!removed) return 0;
  if (!removed.error && removed.status === 0) return staleIds.length;
  return typeof removed.stdout === 'string' ? confirmedRemovals(removed.stdout, selected) : 0;
}

/** The host's reaper: the same plan as `reapContainers`, with docker run in the background. */
export async function reapContainersAsync(
  db: Database,
  stateDirectory: string,
  now = Date.now(),
  defaults = defaultPolicy.containers,
): Promise<number> {
  const policy = containerPolicy(stateDirectory, defaults);
  if (!policy) return 0;
  const listed = await dockerAsync(['ps', '--format', LIST_FORMAT], defaults);
  if (!listed.ok) return 0;
  const selected = staleRemovals(listedRows(listed.stdout), policy, db, now);
  if (!selected.length) return 0;
  const staleIds = selected.map((row) => row.id);
  const removed = await dockerAsync(['rm', '-f', '-v', ...staleIds], defaults);
  if (removed.ok) return staleIds.length;
  return confirmedRemovals(removed.stdout, selected);
}
