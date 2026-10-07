import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { startRestoredServices } from '../../../scripts/ops/restore.ts';
import { GiB, memoryBytes, parseMemoryReading, qaMemoryNeed, waitForMemory,
  qaMemoryDeadline, withMemoryStartup, withQaStackStartup,
  type MemoryReading } from '../../../scripts/qa/memory-admission.ts';

const root = resolve(import.meta.dir, '../../..');
const need = qaMemoryNeed(root, 'other', 'ordinary', {});
const plenty: MemoryReading = { vmTotal: 24 * GiB, vmUsed: 5 * GiB, hostAvailable: 20 * GiB };

test('memory admission budgets Compose caps, resource classes and overridden thresholds', () => {
  expect(need).toEqual({ vm: 5.375 * GiB, host: GiB, hostReserve: 8 * GiB, vmReserve: 0 });
  expect(qaMemoryNeed(root, 'browser', 'large-tmpfs', {}).vm).toBe(10.375 * GiB);
  expect(qaMemoryNeed(root, 'browser', 'catalogue-disk', {}).host).toBe(4 * GiB);
  expect(qaMemoryNeed(root, 'other', undefined, {}).vm).toBe(0);
  expect(qaMemoryNeed(root, 'other', 'ordinary', { REZICS_POSTGRES_MEMORY_LIMIT: '2048MB' }).vm).toBe(need.vm);
  expect(qaMemoryNeed(root, 'browser', 'ordinary', {
    REZICS_FUSEKI_MEMORY_LIMIT: '8g', REZICS_POSTGRES_MEMORY_LIMIT: '1536m',
    REZICS_QA_BROWSER_MEMORY_GIB: '5', REZICS_QA_HOST_RESERVE_GIB: '10', REZICS_QA_VM_RESERVE_GIB: '1',
  })).toEqual({ vm: 10.875 * GiB, host: 5 * GiB, hostReserve: 10 * GiB, vmReserve: GiB });
  expect(() => qaMemoryNeed(root, 'other', 'ordinary', { REZICS_RUSTFS_MEMORY_LIMIT: '0' }))
    .toThrow('finite, positive');
  expect(() => qaMemoryNeed(root, 'other', undefined, { REZICS_QA_HOST_RESERVE_GIB: '-1' }))
    .toThrow('nonnegative');
  expect(() => qaMemoryNeed(root, 'other', undefined, { REZICS_QA_HOST_MEMORY_GIB: '' }))
    .toThrow('nonnegative');
});

const scratch = join(root, '.temp');
mkdirSync(scratch, { recursive: true });
async function untilFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(5);
  expect(existsSync(path)).toBe(true);
}

test('independent QA processes measure after the preceding startup and wait for its memory to clear', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-processes-'));
  const script = join(dir, 'startup.ts');
  writeFileSync(join(dir, 'used'), String(18 * GiB));
  writeFileSync(script, `
    import { withMemoryStartup } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [dir, name] = process.argv.slice(2);
    await withMemoryStartup(${JSON.stringify(need)}, {
      deadline: Date.now() + 5_000, lockFile: join(dir, 'mutex.sqlite'), pollMs: 5,
      announce: message => {
        if (message.startsWith('Waiting for another')) writeFileSync(join(dir, name + '-queued'), message);
        if (message.startsWith('Waiting;')) writeFileSync(join(dir, name + '-short'), message);
      },
      read: async () => {
        const vmUsed = Number(readFileSync(join(dir, 'used'), 'utf8'));
        appendFileSync(join(dir, 'reads'), name + ':' + vmUsed + '\\n');
        return { vmTotal: ${24 * GiB}, vmUsed, hostAvailable: ${20 * GiB} };
      },
    }, async () => {
      writeFileSync(join(dir, name + '-started'), 'started');
      if (name === 'first') {
        while (!existsSync(join(dir, 'release'))) await Bun.sleep(5);
        writeFileSync(join(dir, 'used'), String(${21 * GiB}));
      }
    });
  `);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const first = Bun.spawn(['bun', script, dir, 'first'], { stdout: 'pipe', stderr: 'pipe' });
    children.push(first);
    await untilFile(join(dir, 'first-started'));
    const second = Bun.spawn(['bun', script, dir, 'second'], { stdout: 'pipe', stderr: 'pipe' });
    children.push(second);
    await untilFile(join(dir, 'second-queued'));
    expect(readFileSync(join(dir, 'reads'), 'utf8')).not.toContain('second:');
    writeFileSync(join(dir, 'release'), 'ready');
    expect(await first.exited).toBe(0);
    await untilFile(join(dir, 'second-short'));
    expect(existsSync(join(dir, 'second-started'))).toBe(false);
    expect(readFileSync(join(dir, 'reads'), 'utf8')).toContain(`second:${21 * GiB}`);
    writeFileSync(join(dir, 'used'), String(18 * GiB));
    expect(await second.exited).toBe(0);
    expect(existsSync(join(dir, 'second-started'))).toBe(true);
  } finally {
    for (const child of children) { child.kill(); await child.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test('startup mutex obeys deadlines and releases after memory shortage and startup failure', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-release-'));
  const lockFile = join(dir, 'mutex.sqlite');
  const holder = new Database(lockFile, { create: true });
  let now = 0, started = false;
  const options = { lockFile, deadline: 25, now: () => now, pollMs: 10,
    sleep: async (ms: number) => { now += ms; }, announce: () => {}, read: async () => plenty };
  try {
    holder.exec('BEGIN IMMEDIATE');
    await expect(withMemoryStartup(need, { ...options, read: async () => { throw new Error('Read before lock'); } },
      () => { started = true; })).rejects.toThrow('deadline reached waiting for another QA startup');
    expect(now).toBe(25);
    expect(started).toBe(false);
    holder.exec('ROLLBACK');
    now = 0;
    await expect(withMemoryStartup(need, { ...options, read: async () => ({ ...plenty, vmUsed: plenty.vmTotal }) },
      () => { started = true; })).rejects.toThrow('free 0.00 GiB');
    expect(started).toBe(false);
    now = 0;
    await expect(withMemoryStartup(need, options, () => { throw new Error('Compose failed'); })).rejects.toThrow('Compose failed');
    expect(await withMemoryStartup(need, options, () => 'recovered')).toBe('recovered');
  } finally { holder.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('process death releases the startup mutex without stale-owner bookkeeping', async () => {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const dir = mkdtempSync(join(scratch, 'qa-memory-death-'));
    const lockFile = join(dir, 'mutex.sqlite');
    const ready = join(dir, 'ready');
    const script = join(dir, 'holder.ts');
    writeFileSync(script, `
      import { withMemoryStartup } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
      import { writeFileSync } from 'node:fs';
      await withMemoryStartup(${JSON.stringify(need)}, { lockFile: ${JSON.stringify(lockFile)},
        deadline: Date.now() + 5_000, announce: () => {}, read: async () => (${JSON.stringify(plenty)}) }, async () => {
        writeFileSync(${JSON.stringify(ready)}, 'held');
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    `);
    const child = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
    try {
      await untilFile(ready);
      child.kill(signal);
      await child.exited;
      expect(await withMemoryStartup(need, { lockFile, deadline: Date.now() + 500,
        announce: () => {}, read: async () => plenty }, () => 'recovered')).toBe('recovered');
    } finally { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); }
  }
}, 10_000);

test('each source and restore target startup receives a fresh reading and its inherited deadline', async () => {
  const dir = mkdtempSync(join(scratch, 'qa-memory-children-'));
  let now = 0, used = 0, reads = 0;
  const starts: string[] = [];
  const env = { REZICS_QA_MEMORY_DEADLINE: '25' };
  const options = { lockFile: join(dir, 'mutex.sqlite'), now: () => now, pollMs: 10,
    announce: () => {}, sleep: async (ms: number) => { now += ms; }, read: async () => {
      reads++; return { vmTotal: 12 * GiB, vmUsed: used, hostAvailable: 20 * GiB };
    } };
  try {
    await withQaStackStartup(root, env, 100, () => { starts.push('source'); used = 3 * GiB; }, options);
    const target = (name: string) => ({ environment: env, compose: (args: string[]) => {
      expect(args).toEqual(['up', '-d', '--wait', 'postgres', 'fuseki', 'rustfs']);
      starts.push(name); return '';
    } });
    await expect(startRestoredServices(target('restore-target'), 100, {}, options))
      .rejects.toThrow('free 9.00 GiB');
    expect(starts).toEqual(['source']);
    expect(reads).toBeGreaterThan(1);
    expect(now).toBe(25);
    now = 0; used = 0;
    await startRestoredServices(target('fresh-restore-target'), 100, {}, options);
    expect(starts).toEqual(['source', 'fresh-restore-target']);
    expect(qaMemoryDeadline(env, 10)).toBe(10);
    expect(() => qaMemoryDeadline({ REZICS_QA_MEMORY_DEADLINE: 'unknown' }, 100)).toThrow('Invalid');
    expect(qaMemoryNeed(root, 'other', 'catalogue-disk', {}, ['fuseki']).vm).toBe(7 * GiB);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('host-only admission can start without Docker and still enforces its reserve', async () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    await waitForMemory({ vm: 0, vmReserve: 0, host: 0, hostReserve: 0 }, {
      deadline: Date.now() + 100, announce: () => {},
    });
  } finally { process.env.PATH = previous; }
  let now = 0;
  await expect(waitForMemory({ vm: 0, vmReserve: 0, host: 4 * GiB, hostReserve: 8 * GiB }, {
    deadline: 10, now: () => now, sleep: async ms => { now += ms; }, pollMs: 10, announce: () => {},
    read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: 11 * GiB }),
  })).rejects.toThrow('host needs 4.00 GiB + 8.00 GiB reserve, available 11.00 GiB');
});

test('memory readings sum actual container use, use Docker VM total and host MemAvailable', () => {
  const stats = [JSON.stringify({ MemUsage: '2GiB / 7GiB' }), JSON.stringify({ MemUsage: '512MiB / 2GiB' })].join('\n');
  expect(parseMemoryReading(String(24 * GiB), stats, 'MemFree: 1 kB\nMemAvailable: 10485760 kB\n'))
    .toEqual({ vmTotal: 24 * GiB, vmUsed: 2.5 * GiB, hostAvailable: 10 * GiB });
  expect(parseMemoryReading(String(GiB), '', 'MemAvailable: 1024 kB').vmUsed).toBe(0);
  expect(memoryBytes('128m')).toBe(128 * 1024 ** 2);
  expect(memoryBytes('410.8MiB')).toBe(410.8 * 1024 ** 2);
  expect(memoryBytes('1MB')).toBe(1_000_000);
  expect(() => parseMemoryReading('0', '', 'MemAvailable: 1024 kB')).toThrow('Cannot read');
  expect(() => parseMemoryReading(String(GiB), '{}', 'MemAvailable: 1024 kB')).toThrow('container memory');
  expect(() => memoryBytes('unknown')).toThrow('Invalid memory size');
});

for (const short of ['vm', 'host'] as const) {
  test(`memory admission waits while ${short} is short, then admits at the boundary`, async () => {
    let now = 0, reads = 0;
    const messages: string[] = [];
    await waitForMemory(need, {
      deadline: 30, now: () => now, sleep: async ms => { now += ms; }, pollMs: 10,
      announce: message => messages.push(message),
      read: async () => {
        reads++;
        return { ...plenty,
          ...(short === 'vm' ? { vmUsed: plenty.vmTotal - need.vm + (reads === 1 ? 1 : 0) }
            : { hostAvailable: need.host + need.hostReserve - (reads === 1 ? 1 : 0) }),
        };
      },
    });
    expect(now).toBe(10);
    expect(reads).toBe(2);
    expect(messages[0]).toContain('Waiting; QA memory: Docker VM needs 5.38 GiB');
    expect(messages[0]).toContain('free ');
    expect(messages[0]).toContain('host needs 1.00 GiB + 8.00 GiB reserve, available ');
    expect(messages[1]).toStartWith('Admitted;');
  });
}

test('memory admission deadline reports both shortages and never admits late readings', async () => {
  let now = 0;
  const messages: string[] = [];
  await expect(waitForMemory(need, {
    deadline: 25, now: () => now, sleep: async ms => { now += ms; }, pollMs: 10,
    announce: message => messages.push(message), read: async () => ({ ...plenty, vmUsed: 24 * GiB, hostAvailable: GiB }),
  })).rejects.toThrow('Docker VM needs 5.38 GiB + 0.00 GiB reserve, free 0.00 GiB; host needs 1.00 GiB + 8.00 GiB reserve, available 1.00 GiB');
  expect(now).toBe(25);
  expect(messages.every(message => message.startsWith('Waiting;'))).toBe(true);
  now = 0;
  await expect(waitForMemory(need, { deadline: 10, now: () => now, announce: () => {},
    read: async remaining => { expect(remaining).toBe(10); now = 10; return plenty; },
  })).rejects.toThrow('deadline reached');
});

test('unavailable readings fail closed, retry and retain the reason at the deadline', async () => {
  let now = 0, reads = 0;
  const messages: string[] = [];
  const options = { deadline: 15, now: () => now, sleep: async (ms: number) => { now += ms; }, pollMs: 10,
    announce: (message: string) => messages.push(message) };
  await waitForMemory(need, { ...options, read: async () => {
    if (++reads === 1) throw new Error('Docker unavailable');
    return plenty;
  } });
  expect(messages[0]).toContain('free unknown; host needs');
  expect(messages[0]).toContain('Docker unavailable');
  now = 0;
  await expect(waitForMemory(need, { ...options, read: async () => { throw new Error('Docker unavailable'); } }))
    .rejects.toThrow('measurement failed: Docker unavailable; no work started');
  expect(now).toBe(15);
});
