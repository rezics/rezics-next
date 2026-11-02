import type { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ContainerPolicy = { maxAgeHours: number; keep: string[] };
export type ContainerRow = { id: string; name: string; createdMs: number };

const DOCKER_TIMEOUT_MS = 15_000;

function normalizePolicy(value: unknown): ContainerPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'maxAgeHours' && key !== 'keep')) return undefined;
  const maxAgeHours = raw.maxAgeHours === undefined ? 4 : raw.maxAgeHours;
  const keep = raw.keep === undefined ? [] : raw.keep;
  if (typeof maxAgeHours !== 'number' || !Number.isFinite(maxAgeHours) || maxAgeHours < 0) return undefined;
  if (!Array.isArray(keep) || keep.some((prefix) => typeof prefix !== 'string' || prefix.length === 0))
    return undefined;
  return { maxAgeHours, keep: keep as string[] };
}

function docker(args: string[]) {
  try {
    return spawnSync('docker', args, { encoding: 'utf8', timeout: DOCKER_TIMEOUT_MS });
  } catch {
    return undefined;
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
  const maxAgeMs = validPolicy.maxAgeHours * 3_600_000;
  return rows
    .filter((row) => now - row.createdMs >= maxAgeMs)
    .filter((row) => !validPolicy.keep.some((prefix) => row.name.startsWith(prefix)))
    .filter((row) => !running.some((taskId) => row.name.includes(taskId.slice(0, 8))))
    .map((row) => row.id);
}

function confirmedRemovals(stdout: string, selected: readonly ContainerRow[]): number {
  const confirmations = new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return selected.filter((row) => confirmations.has(row.id) || confirmations.has(row.name)).length;
}

/** Removes stale containers when `<state>/containers.json` sets a policy; a host without it removes nothing. */
export function reapContainers(db: Database, stateDirectory: string, now = Date.now()): number {
  const file = join(stateDirectory, 'containers.json');
  if (!existsSync(file)) return 0;
  let policyValue: unknown;
  try {
    policyValue = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return 0;
  }
  const policy = normalizePolicy(policyValue);
  if (!policy) return 0;

  const listed = docker(['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.CreatedAt}}']);
  if (!listed || listed.error || listed.status !== 0 || typeof listed.stdout !== 'string') return 0;
  const rows = listed.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id = '', name = '', created = ''] = line.split('\t');
      // Docker prints "2026-10-27 21:50:54 +0800 CST".
      const [date, time, zone = '+0000'] = created.split(' ');
      return { id, name, createdMs: Date.parse(`${date}T${time}${zone.slice(0, 3)}:${zone.slice(3, 5)}`) };
    })
    .filter((row) => row.id && Number.isFinite(row.createdMs));
  const running = (
    db.query("SELECT task_id FROM worker_attempts WHERE json_extract(body, '$.state') = 'running'").all() as {
      task_id: string;
    }[]
  ).map((row) => row.task_id);
  const staleIds = [...new Set(staleContainers(rows, policy, running, now))];
  if (!staleIds.length) return 0;
  const selected = staleIds.map((id) => rows.find((row) => row.id === id)!).filter(Boolean);
  const removed = docker(['rm', '-f', '-v', ...staleIds]);
  if (!removed) return 0;
  if (!removed.error && removed.status === 0) return staleIds.length;
  return typeof removed.stdout === 'string' ? confirmedRemovals(removed.stdout, selected) : 0;
}
