import type { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ContainerPolicy = { maxAgeHours: number; keep: string[] };
export type ContainerRow = { id: string; name: string; createdMs: number };

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
  const maxAgeMs = policy.maxAgeHours * 3_600_000;
  return rows
    .filter((row) => now - row.createdMs >= maxAgeMs)
    .filter((row) => !policy.keep.some((prefix) => row.name.startsWith(prefix)))
    .filter((row) => !running.some((taskId) => row.name.includes(taskId.slice(0, 8))))
    .map((row) => row.id);
}

/** Removes stale containers when `<state>/containers.json` sets a policy; a host without it removes nothing. */
export function reapContainers(db: Database, stateDirectory: string, now = Date.now()): number {
  const file = join(stateDirectory, 'containers.json');
  if (!existsSync(file)) return 0;
  const policy = { maxAgeHours: 4, keep: [], ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<ContainerPolicy>) };
  const listed = spawnSync('docker', ['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.CreatedAt}}'], { encoding: 'utf8' });
  if (listed.status !== 0) return 0;
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
  const stale = staleContainers(rows, policy, running, now);
  if (stale.length) spawnSync('docker', ['rm', '-f', '-v', ...stale], { stdio: 'ignore' });
  return stale.length;
}
