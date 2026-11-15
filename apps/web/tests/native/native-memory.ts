import { closeSync, openSync, readSync } from 'node:fs';
import { basename, posix } from 'node:path';
import type { NativeProcessIdentity } from './lifecycle.ts';

type Role = 'fixture-host' | 'durable-worker' | 'web-worker';
export type NativeMemoryRoot = {
  role: Role;
  pid?: number | undefined;
  identity?: NativeProcessIdentity | undefined;
};
type Read = (path: string, limit: number) => string;
type Unavailable = { role: Role; pid?: number | undefined; reason: string };
type ProcessRow = {
  role: Role;
  pid: number;
  parentPid: number;
  startTime: string;
  name: string | null;
  kind: 'root' | 'descendant';
  rssBytes: number | null;
};
type CgroupMemory =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'observed';
      depthFromCommand: number;
      currentBytes: number;
      anonBytes: number;
      fileBytes: number;
      shmemBytes: number;
      maxBytes: number | 'max';
      cumulativePeakBytes: number | null;
      cumulativeEvents: { oom: number; oomKill: number; high: number; max: number } | null;
    };
export type NativeMemoryObservation = {
  sampledAt: string;
  cgroup: { command: CgroupMemory; runSlice: CgroupMemory };
  /** A nonadditive RSS subset, not the cgroup's total or unique physical memory. */
  processes: {
    observedRssBytes: number | null;
    rows: ProcessRow[];
    truncated: boolean;
    unavailable: Unavailable[];
    unavailableTruncated: boolean;
  };
};

function boundedRead(path: string, limit: number): string {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.allocUnsafe(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new Error('truncated');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function integer(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error('invalid_counter');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('invalid_counter');
  return result;
}
function counters(value: string): Map<string, string> {
  return new Map(
    value
      .trim()
      .split('\n')
      .map((line) => {
        const [key, count, extra] = line.trim().split(/\s+/);
        if (!key || count === undefined || extra !== undefined) throw new Error('invalid_counters');
        return [key, count];
      }),
  );
}
function optional<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function cgroupPaths(read: Read, declaredSlice: string | undefined) {
  const membership = read('/proc/self/cgroup', 4096)
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3);
  if (!membership?.startsWith('/') || membership.split('/').includes('..')) throw new Error('cgroup_v2_unavailable');
  const mount = read('/proc/self/mountinfo', 65536)
    .split('\n')
    .find((line) => line.includes(' - cgroup2 '));
  const fields = mount?.split(' ');
  if (!fields?.[3] || !fields[4]) throw new Error('cgroup_mount_unavailable');
  const root = unescapeMount(fields[3]);
  const mountpoint = unescapeMount(fields[4]);
  const relative = posix.relative(root, membership);
  if (relative === '..' || relative.startsWith('../') || !mountpoint.startsWith('/'))
    throw new Error('cgroup_namespace_unavailable');
  const command = posix.join(mountpoint, relative);
  const expected = declaredSlice === undefined ? undefined : basename(declaredSlice);
  let ancestor = posix.dirname(command),
    depth = 1;
  while (ancestor !== command && (ancestor === mountpoint || ancestor.startsWith(`${mountpoint}/`))) {
    const name = posix.basename(ancestor);
    if (expected ? name === expected : name.endsWith('.slice')) return { command, run: ancestor, depth };
    if (ancestor === mountpoint) break;
    ancestor = posix.dirname(ancestor);
    depth++;
  }
  return { command, run: null, depth: 0 };
}
function cgroupMemory(read: Read, path: string, depth: number): CgroupMemory {
  try {
    const stat = counters(read(`${path}/memory.stat`, 16384));
    const maximum = read(`${path}/memory.max`, 128).trim();
    const events = optional(() => {
      const values = counters(read(`${path}/memory.events`, 4096));
      return {
        oom: integer(values.get('oom')),
        oomKill: integer(values.get('oom_kill')),
        high: integer(values.get('high')),
        max: integer(values.get('max')),
      };
    });
    return {
      status: 'observed',
      depthFromCommand: depth,
      currentBytes: integer(read(`${path}/memory.current`, 128).trim()),
      anonBytes: integer(stat.get('anon')),
      fileBytes: integer(stat.get('file')),
      shmemBytes: integer(stat.get('shmem')),
      maxBytes: maximum === 'max' ? 'max' : integer(maximum),
      cumulativePeakBytes: optional(() => integer(read(`${path}/memory.peak`, 128).trim())),
      cumulativeEvents: events,
    };
  } catch {
    return { status: 'unavailable', reason: 'cgroup_counters_unavailable_or_invalid' };
  }
}
function processStat(value: string) {
  const end = value.lastIndexOf(')');
  if (end < 0) throw new Error('invalid_stat');
  const fields = value
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error('invalid_start_time');
  return { parentPid: integer(fields[1]), pgid: integer(fields[2]), sid: integer(fields[3]), startTime: fields[19] };
}

/** Inspect only supplied identities and their kernel-reported children; never enumerate other jobs. */
export function sampleNativeMemory(
  roots: readonly NativeMemoryRoot[],
  read: Read = boundedRead,
  declaredSlice = process.env.REZICS_CHECK_SLICE,
): NativeMemoryObservation {
  const missing: CgroupMemory = { status: 'unavailable', reason: 'cgroup_membership_or_mount_unavailable' };
  let cgroup: NativeMemoryObservation['cgroup'] = { command: missing, runSlice: missing };
  try {
    const paths = cgroupPaths(read, declaredSlice);
    cgroup = {
      command: cgroupMemory(read, paths.command, 0),
      runSlice: paths.run
        ? cgroupMemory(read, paths.run, paths.depth)
        : { status: 'unavailable', reason: 'owned_run_slice_not_found' },
    };
  } catch {
    /* Absence is explicit; it never becomes a zero-byte observation. */
  }
  const rows: ProcessRow[] = [],
    unavailable: Unavailable[] = [];
  let truncated = roots.length > 3,
    unavailableTruncated = false;
  const fail = (value: Unavailable) => {
    if (unavailable.length < 8) unavailable.push(value);
    else unavailableTruncated = true;
  };
  const seen = new Set<number>();
  // More-specific roots own their descendants before the enclosing host is visited.
  const sorted = [...roots]
    .slice(0, 3)
    .sort((a, b) => Number(a.role === 'fixture-host') - Number(b.role === 'fixture-host'));
  for (const [rootIndex, root] of sorted.entries()) {
    if (!root.identity || root.pid !== root.identity.pid) {
      fail({ role: root.role, pid: root.pid, reason: root.pid ? 'identity_unavailable' : 'not_started' });
      continue;
    }
    const queue: { pid: number; parent?: { pid: number; startTime: string }; identity?: NativeProcessIdentity }[] = [
      { pid: root.identity.pid, identity: root.identity },
    ];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next.pid)) continue;
      const reservedRoots = sorted.length - rootIndex - 1;
      if (seen.size >= 32 || (!next.identity && seen.size >= 32 - reservedRoots)) {
        truncated = true;
        break;
      }
      seen.add(next.pid);
      try {
        const before = processStat(read(`/proc/${next.pid}/stat`, 4096));
        if (
          !before.startTime ||
          (next.parent !== undefined &&
            (before.parentPid !== next.parent.pid ||
              processStat(read(`/proc/${next.parent.pid}/stat`, 4096)).startTime !== next.parent.startTime)) ||
          (next.identity &&
            (before.startTime !== next.identity.startTime ||
              before.pgid !== next.identity.pgid ||
              before.sid !== next.identity.sid))
        )
          throw new Error('identity_changed');
        const rssBytes = optional(() => {
          const match = /^VmRSS:\s+(\d+) kB$/m.exec(read(`/proc/${next.pid}/status`, 16384));
          const bytes = integer(match?.[1]) * 1024;
          if (!Number.isSafeInteger(bytes)) throw new Error('invalid_rss');
          return bytes;
        });
        const name = optional(() => {
          const value = read(`/proc/${next.pid}/comm`, 256).trim();
          if (!value || value.length > 64) throw new Error('invalid_process_name');
          return value.replace(/[^a-zA-Z0-9._+-]/g, '?');
        });
        const after = processStat(read(`/proc/${next.pid}/stat`, 4096));
        if (after.startTime !== before.startTime || after.parentPid !== before.parentPid)
          throw new Error('identity_changed');
        rows.push({
          role: root.role,
          pid: next.pid,
          parentPid: before.parentPid,
          startTime: before.startTime,
          name,
          kind: next.identity ? 'root' : 'descendant',
          rssBytes,
        });
        if (rssBytes === null) fail({ role: root.role, pid: next.pid, reason: 'rss_unavailable_or_invalid' });
        try {
          const children = read(`/proc/${next.pid}/task/${next.pid}/children`, 4096).trim();
          for (const child of children ? children.split(/\s+/) : []) {
            if (queue.length + seen.size >= 32 - reservedRoots) {
              truncated = true;
              break;
            }
            queue.push({ pid: integer(child), parent: { pid: next.pid, startTime: before.startTime } });
          }
        } catch {
          fail({ role: root.role, pid: next.pid, reason: 'children_unavailable_or_truncated' });
          truncated = true;
        }
      } catch {
        fail({ role: root.role, pid: next.pid, reason: 'process_unavailable_or_identity_changed' });
      }
    }
  }
  const observed = rows.filter((row) => row.rssBytes !== null);
  return {
    sampledAt: new Date().toISOString(),
    cgroup,
    processes: {
      observedRssBytes: observed.length ? observed.reduce((sum, row) => sum + row.rssBytes!, 0) : null,
      rows,
      truncated,
      unavailable,
      unavailableTruncated,
    },
  };
}
