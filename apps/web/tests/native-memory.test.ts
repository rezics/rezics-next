import { expect, test } from 'bun:test';
import { sampleNativeMemory } from './native/native-memory';

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
