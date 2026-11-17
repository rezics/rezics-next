import { expect, test } from 'bun:test';
import { sampleNativeMemory, sampleOwnedWebRunMemory } from './native/native-memory';

function files() {
  const values = new Map<string, string>([
    ['/proc/self/cgroup', '0::/jobs/owned.slice/check.scope\n'],
    ['/proc/self/mountinfo', '20 1 0:20 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n'],
  ]);
  const reads: string[] = [];
  for (const [path, current, max] of [
    ['/sys/fs/cgroup/jobs/owned.slice/check.scope', '7000', '8589934592'],
    ['/sys/fs/cgroup/jobs/owned.slice', '9000', 'max'],
  ]) {
    values.set(`${path}/memory.current`, current!);
    values.set(`${path}/memory.max`, max!);
    values.set(`${path}/memory.stat`, 'anon 4000\nfile 2000\nshmem 1000\n');
    values.set(`${path}/memory.peak`, '12000');
    values.set(`${path}/memory.events`, 'low 0\nhigh 1\nmax 2\noom 3\noom_kill 4\n');
  }
  const process = (pid: number, parent: number, children = '', startTime = '100', rss = '10') => {
    const fields = Array.from({ length: 22 }, () => '0');
    fields[0] = 'R';
    fields[1] = String(parent);
    fields[2] = String(pid);
    fields[3] = '1';
    fields[19] = startTime;
    values.set(`/proc/${pid}/stat`, `${pid} (native worker) ${fields.join(' ')}`);
    values.set(`/proc/${pid}/status`, `VmRSS: ${rss} kB\n`);
    values.set(`/proc/${pid}/comm`, 'bun\n');
    values.set(`/proc/${pid}/task/${pid}/children`, children);
    return { pid, pgid: pid, sid: 1, startTime };
  };
  const read = (path: string, limit: number) => {
    reads.push(path);
    const value = values.get(path);
    if (value === undefined || Buffer.byteLength(value) > limit) throw new Error('unavailable');
    return value;
  };
  return { values, reads, process, read };
}

test('memory distinguishes current command budget, ancestor slice and cumulative counters, and follows owned detached children only', () => {
  const f = files();
  const host = f.process(1, 0, '10 20');
  const web = f.process(10, 1, '11 12');
  const durable = f.process(20, 1);
  f.process(11, 10); // A detached descendant remains owned by its exact parent, irrespective of PGID.
  f.process(12, 999); // Reparented/reused PID is not admitted from an old children observation.
  f.process(88, 0);
  const result = sampleNativeMemory(
    [
      { role: 'fixture-host', pid: 1, identity: host },
      { role: 'web-worker', pid: 10, identity: web },
      { role: 'durable-worker', pid: 20, identity: durable },
    ],
    f.read,
    'owned.slice',
  );
  expect(result.cgroup.command).toMatchObject({
    status: 'observed',
    currentBytes: 7000,
    maxBytes: 8589934592,
    depthFromCommand: 0,
  });
  expect(result.cgroup.runSlice).toMatchObject({
    status: 'observed',
    currentBytes: 9000,
    maxBytes: 'max',
    depthFromCommand: 1,
    cumulativePeakBytes: 12000,
    cumulativeEvents: { oomKill: 4 },
  });
  expect(result.processes.rows.map((row) => row.pid)).toEqual([10, 11, 20, 1]);
  expect(result.processes.rows.find((row) => row.pid === 11)).toMatchObject({
    role: 'web-worker',
    kind: 'descendant',
    startTime: '100',
    rssBytes: 10240,
  });
  expect(result.processes.observedRssBytes).toBe(40960);
  expect(f.reads.some((path) => path.startsWith('/proc/88/'))).toBe(false);
});

test('PID reuse, inaccessible counters and absent RSS remain unavailable rather than zero observations', () => {
  const f = files();
  const identity = f.process(1, 0);
  f.process(1, 0, '', '200');
  f.values.delete('/proc/self/cgroup');
  const changed = sampleNativeMemory([{ role: 'fixture-host', pid: 1, identity }], f.read);
  expect(changed.processes.rows).toEqual([]);
  expect(changed.processes.observedRssBytes).toBeNull();
  expect(changed.cgroup.command.status).toBe('unavailable');
  expect(changed.processes.unavailable).toEqual([
    { role: 'fixture-host', pid: 1, reason: 'process_unavailable_or_identity_changed' },
  ]);
  f.process(1, 0);
  f.values.set('/proc/1/status', 'VmRSS: invalid kB\n');
  const missing = sampleNativeMemory([{ role: 'fixture-host', pid: 1, identity }], f.read);
  expect(missing.processes.rows[0]!.rssBytes).toBeNull();
  expect(missing.processes.observedRssBytes).toBeNull();
});

test('owned process traversal has an explicit 32-row ceiling and does not probe the omitted tail', () => {
  const f = files();
  const children = Array.from({ length: 100 }, (_, index) => index + 2);
  const identity = f.process(1, 0, children.join(' '));
  for (const pid of children) f.process(pid, 1);
  const result = sampleNativeMemory([{ role: 'fixture-host', pid: 1, identity }], f.read);
  expect(result.processes.rows).toHaveLength(32);
  expect(result.processes.truncated).toBe(true);
  expect(f.reads.some((path) => path.startsWith('/proc/101/'))).toBe(false);
});

test('Web startup memory attributes PSS only to roles in the exact owned slice', () => {
  const f = files();
  const run = 'abc12-1234abcd';
  const slice = 'rezics-check-abc12_1234abcd.slice';
  const membership = `/jobs/${slice}`;
  const scopeName = `rezics-check-${run}.scope`;
  const scope = `${membership}/${scopeName}`;
  const cgroup = '/sys/fs/cgroup';
  const env = { REZICS_CHECK_RUN: run, REZICS_CHECK_SLICE: slice };
  f.values.set('/proc/self/cgroup', `0::${scope}\n`);
  f.values.set(`${cgroup}${membership}/memory.current`, '7890');
  f.values.set(`${cgroup}${membership}/memory.max`, '8589934592');
  f.values.set(`${cgroup}${membership}/memory.stat`, 'anon 4000\nfile 2000\nshmem 1000\nkernel 90\n');
  f.values.set(`${cgroup}${membership}/memory.events`, 'high 0\nmax 2\noom 3\noom_kill 4\n');
  f.values.set(`${cgroup}${membership}/cgroup.procs`, '');
  f.values.set(`${cgroup}${scope}/cgroup.procs`, '10\n11\n12\n13\n14\n');
  for (const pid of [10, 11, 12, 13, 14]) f.process(pid, 1);
  for (const pid of [10, 11, 12, 14]) f.values.set(`/proc/${pid}/cgroup`, `0::${scope}\n`);
  f.values.set('/proc/13/cgroup', '0::/jobs/other.scope\n');
  f.values.set('/proc/10/smaps_rollup', 'Pss: 25 kB\n');
  f.values.set('/proc/11/cmdline', '/usr/bin/bun\0services/auth/scripts/dev-stack.ts\0web\0PRIVATE');
  f.values.set('/proc/11/smaps_rollup', 'Pss: 12 kB\n');
  f.values.set('/proc/12/cmdline', '/private/chrome-headless-shell\0--private\0');
  const children = (path: string) => ({
    names: path === cgroup + membership ? [scopeName] : [],
    truncated: false,
  });
  f.values.set('/proc/14/cmdline', '/usr/bin/node\0vite\0--config\0vite.config.ts\0');
  f.values.set('/proc/14/smaps_rollup', 'Pss: 50 kB\n');
  const result = sampleOwnedWebRunMemory('other', env, f.read, children, () => '/private/apps/web', 10);
  expect(result).toMatchObject({
    status: 'observed',
    memory: {
      currentBytes: 7890,
      maxBytes: 8589934592,
      anonBytes: 4000,
      fileBytes: 2000,
      shmemBytes: 1000,
      kernelBytes: 90,
      cumulativeEvents: { oom: 3, oomKill: 4 },
    },
    processes: {
      partial: false,
      unavailableCount: 1,
      roles: {
        vite: { count: 1, pssCount: 1, pssBytes: 51200 },
        other: { count: 1, pssCount: 1, pssBytes: 25600 },
        webPreparer: { count: 1, pssCount: 1, pssBytes: 12288 },
        chromium: { count: 1, pssCount: 0, pssBytes: null },
      },
    },
  });
  expect(f.reads).not.toContain('/proc/13/smaps_rollup');
  expect(JSON.stringify(result)).not.toContain('PRIVATE');

  f.reads.length = 0;
  f.values.set('/proc/self/cgroup', `0::${membership}/other.scope\n`);
  expect(sampleOwnedWebRunMemory('vite', env, f.read, children)).toMatchObject({
    status: 'unavailable',
    reason: 'owned_run_slice_unavailable',
  });
  expect(f.reads).toEqual(['/proc/self/cgroup', '/proc/self/mountinfo']);
});
