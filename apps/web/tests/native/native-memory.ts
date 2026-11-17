import { closeSync, opendirSync, openSync, readlinkSync, readSync, writeSync } from 'node:fs';
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
      kernelBytes: number | null;
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

function cgroupMembership(read: Read, path: string): string {
  const membership = read(path, 4096)
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3);
  if (!membership?.startsWith('/') || membership.split('/').includes('..')) throw new Error('cgroup_v2_unavailable');
  return membership;
}

function cgroupPaths(read: Read, declaredSlice: string | undefined) {
  const membership = cgroupMembership(read, '/proc/self/cgroup');
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
    if (expected ? name === expected : name.endsWith('.slice'))
      return { command, run: ancestor, runMembership: posix.join(root, posix.relative(mountpoint, ancestor)), depth };
    if (ancestor === mountpoint) break;
    ancestor = posix.dirname(ancestor);
    depth++;
  }
  return { command, run: null, runMembership: null, depth: 0 };
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
      kernelBytes: optional(() => integer(stat.get('kernel'))),
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

export const webStartupMemoryOptIn = 'REZICS_WEB_STARTUP_MEMORY';
export const webStartupMemoryAdmitted = 'REZICS_WEB_STARTUP_MEMORY_ADMITTED';

type WebMemoryCheckpoint =
  | 'declarations-before'
  | 'declarations-after'
  | 'vite-listen'
  | 'ssr-5000'
  | 'ssr-6250'
  | 'client-2500'
  | 'client-3750';
type WebMemoryRole =
  | 'vite'
  | 'webPreparer'
  | 'kernelHttp'
  | 'auth'
  | 'authPages'
  | 'worker'
  | 'workerd'
  | 'chromium'
  | 'other';
type RoleMemory = { count: number; pssCount: number; pssBytes: number | null };
type ReadChildren = (path: string) => { names: string[]; truncated: boolean };

function boundedCgroupChildren(path: string): ReturnType<ReadChildren> {
  const directory = opendirSync(path);
  const names: string[] = [];
  try {
    for (let scanned = 0; scanned < 128; scanned++) {
      const entry = directory.readSync();
      if (!entry) return { names, truncated: false };
      if (entry.isDirectory()) names.push(entry.name);
    }
    return { names, truncated: true };
  } finally {
    directory.closeSync();
  }
}

function webMemoryRole(args: string[], cwd: () => string): WebMemoryRole {
  const command = posix.basename(args[0] ?? '');
  if (/^(chrome|chromium|chrome-headless-shell|headless_shell|chrome_crashpad_handler)$/.test(command))
    return 'chromium';
  if (command === 'workerd') return 'workerd';
  if (args.some((arg) => posix.basename(arg) === 'work-auth-worker.ts')) return 'worker';
  const stack = args.findIndex((arg) => posix.basename(arg) === 'dev-stack.ts');
  if (stack !== -1 && args[stack + 1] === 'web') return 'webPreparer';
  if (stack !== -1 && args[stack + 1] === 'host') return 'auth';
  if (
    args.some((arg) => arg === 'src/server.ts' || arg.endsWith('/services/kernel/src/server.ts')) &&
    cwd().endsWith('/services/kernel')
  )
    return 'kernelHttp';
  if (args.some((arg) => posix.basename(arg) === 'vite.config.ts') && cwd().endsWith('/apps/auth')) return 'authPages';
  return 'other';
}

/** Inspect only the slice and command scope named by the owning physical run. Process totals are PSS observations;
 * cgroup charges (including file cache) are independent. Only aggregate roles leave this reader.
 */
export function sampleWebStartupMemory(
  selfRole: 'webPreparer' | 'vite',
  env = process.env,
  read: Read = boundedRead,
  readChildren: ReadChildren = boundedCgroupChildren,
  readCwd: (pid: number) => string = (pid) => readlinkSync(`/proc/${pid}/cwd`),
  selfPid = process.pid,
) {
  const run = env.REZICS_CHECK_RUN;
  const slice = env.REZICS_CHECK_SLICE;
  if (!run || !/^[a-z0-9]+-[a-f0-9]{8}$/.test(run) || slice !== `rezics-check-${run.replaceAll('-', '_')}.slice`)
    return { status: 'unavailable', reason: 'owned_run_not_declared' };
  const paths = optional(() => cgroupPaths(read, slice));
  if (!paths?.run || !paths.runMembership || posix.basename(paths.command) !== `rezics-check-${run}.scope`)
    return { status: 'unavailable', reason: 'owned_run_slice_unavailable' };
  const memory = cgroupMemory(read, paths.run, paths.depth);
  const directories = [paths.run];
  const pids = new Set<number>();
  let partial = false;
  for (const directory of directories) {
    try {
      const procs = read(`${directory}/cgroup.procs`, 4096).trim();
      for (const pid of procs ? procs.split(/\s+/) : []) {
        if (pids.size === 48) {
          partial = true;
          break;
        }
        pids.add(integer(pid));
      }
    } catch {
      partial = true;
    }
    try {
      const children = readChildren(directory);
      partial ||= children.truncated || directories.length + children.names.length > 12;
      for (const child of children.names.slice(0, 12 - directories.length))
        directories.push(posix.join(directory, child));
    } catch {
      partial = true;
    }
  }
  const roles: Partial<Record<WebMemoryRole, RoleMemory>> = {};
  let unavailableCount = 0;
  for (const pid of pids) {
    const observed = optional(() => {
      const proc = `/proc/${pid}`;
      const before = processStat(read(`${proc}/stat`, 4096));
      const member = cgroupMembership(read, `${proc}/cgroup`);
      if (member !== paths.runMembership && !member.startsWith(`${paths.runMembership}/`)) return null;
      const role =
        pid === selfPid
          ? selfRole
          : (optional(() => webMemoryRole(read(`${proc}/cmdline`, 8192).split('\0'), () => readCwd(pid))) ?? 'other');
      const pss = optional(() => 1024 * integer(/^Pss:\s+(\d+) kB$/m.exec(read(`${proc}/smaps_rollup`, 4096))?.[1]));
      if (
        processStat(read(`${proc}/stat`, 4096)).startTime !== before.startTime ||
        cgroupMembership(read, `${proc}/cgroup`) !== member
      )
        return null;
      return { role, pss };
    });
    if (!observed) {
      unavailableCount++;
      continue;
    }
    const row = (roles[observed.role] ??= { count: 0, pssCount: 0, pssBytes: null });
    row.count++;
    if (observed.pss !== null) {
      row.pssCount++;
      row.pssBytes = (row.pssBytes ?? 0) + observed.pss;
    }
  }
  return { status: 'observed', memory, processes: { partial, unavailableCount, roles } };
}

const webMemoryCheckpoints = new Set<WebMemoryCheckpoint>();

export function logWebStartupMemory(checkpoint: WebMemoryCheckpoint, selfRole: 'webPreparer' | 'vite'): void {
  if (webMemoryCheckpoints.has(checkpoint)) return;
  webMemoryCheckpoints.add(checkpoint);
  const sampledAt = new Date().toISOString();
  const observation = optional(() => sampleWebStartupMemory(selfRole)) ?? {
    status: 'unavailable',
    reason: 'memory_sample_unavailable',
  };
  try {
    writeSync(2, `[web-startup-memory] ${JSON.stringify({ checkpoint, sampledAt, ...observation })}\n`);
  } catch {
    // Diagnostics do not interrupt startup if the output pipe is already gone.
  }
}
