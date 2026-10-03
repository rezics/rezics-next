import { spawnSync } from 'node:child_process';
import { loadDockerEnvironment } from './docker-env.ts';
import { parseCgroupMemory } from './measurement.ts';

export interface TdbStorageSnapshot {
  tdbLogicalBytes: number;
  tdbAllocatedBytes: number;
  luceneLogicalBytes: number;
  luceneAllocatedBytes: number;
  memory: ReturnType<typeof parseCgroupMemory>;
}

/** Sum file sizes and filesystem blocks separately: TDB2 preallocates files,
 * and a one-command size delta can be zero despite changing many pages. */
export function parseFileStorage(raw: string): { logicalBytes: number; allocatedBytes: number } {
  let logicalBytes = 0, allocatedBytes = 0;
  const lines = raw.trim().split('\n').filter(Boolean);
  if (!lines.length) throw new Error('No storage files observed');
  for (const line of lines) {
    const match = /^(\d+) (\d+)$/.exec(line);
    if (!match) throw new Error('Invalid storage file counter');
    logicalBytes += Number(match[1]);
    allocatedBytes += Number(match[2]) * 512;
    if (!Number.isSafeInteger(logicalBytes) || !Number.isSafeInteger(allocatedBytes))
      throw new Error('Storage counters exceed exact integer range');
  }
  return { logicalBytes, allocatedBytes };
}

/** Inspect only the selected QA project's storage, never a live TDB2 database
 * through another JVM. These filesystem counters include retained generations. */
export function qaTdbStorage(runId: string, env = loadDockerEnvironment()): TdbStorageSnapshot {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) throw new Error('Invalid QA storage run-id');
  const command = (args: string[]) => {
    const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0 || result.error) throw new Error('QA storage inspection failed');
    return result.stdout.trim();
  };
  const container = command(['ps', '-q', '--filter',
    `label=com.docker.compose.project=rezics-qa-${runId}`,
    '--filter', 'label=com.docker.compose.service=fuseki']);
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Expected one QA Fuseki container');
  const mounts = JSON.parse(command(['inspect', container, '--format', '{{json .Mounts}}'])) as
    { Destination: string; Type: string }[];
  if (!mounts.some(mount => mount.Destination === '/fuseki/databases' && mount.Type === 'volume'))
    throw new Error('Catalogue scale requires disk-backed Fuseki storage');
  const tdb = parseFileStorage(command(['exec', container, 'find',
    '/fuseki/databases/rezics/tdb2', '-type', 'f', '-printf', '%s %b\n']));
  const lucene = parseFileStorage(command(['exec', container, 'find',
    '/fuseki/databases/rezics/lucene', '-type', 'f', '-printf', '%s %b\n']));
  const memory = parseCgroupMemory(command(['exec', container, 'cat',
    '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.peak',
    '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.stat']));
  return { tdbLogicalBytes: tdb.logicalBytes, tdbAllocatedBytes: tdb.allocatedBytes,
    luceneLogicalBytes: lucene.logicalBytes, luceneAllocatedBytes: lucene.allocatedBytes, memory };
}

export function tdbGrowth(before: TdbStorageSnapshot, after: TdbStorageSnapshot, writes: number) {
  if (!Number.isSafeInteger(writes) || writes < 1) throw new Error('Invalid storage write count');
  return {
    writes,
    tdbLogicalBytesPerWrite: (after.tdbLogicalBytes - before.tdbLogicalBytes) / writes,
    tdbAllocatedBytesPerWrite: (after.tdbAllocatedBytes - before.tdbAllocatedBytes) / writes,
    luceneLogicalBytesPerWrite: (after.luceneLogicalBytes - before.luceneLogicalBytes) / writes,
    luceneAllocatedBytesPerWrite: (after.luceneAllocatedBytes - before.luceneAllocatedBytes) / writes,
  };
}
