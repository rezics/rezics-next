import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { GiB, memoryBytes, parseMemoryReading, qaMemoryNeed, waitForMemory,
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
