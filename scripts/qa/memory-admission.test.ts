import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { dockerUnavailableMessage } from '../load/docker-env.ts';
import { GiB, measuredAdmissionMessage, parseMemoryReading, waitForMemory, withMemoryStartup,
  type MemoryNeed, type MemoryReading } from './memory-admission.ts';

const root = resolve(import.meta.dir, '../..');
const need: MemoryNeed = { vm: 5 * GiB, host: GiB, vmReserve: 2 * GiB, hostReserve: 8 * GiB };
const native: MemoryReading = { engine: 'native', vmTotal: 64 * GiB, vmUsed: 20 * GiB,
  hostAvailable: 14 * GiB, containers: {} };
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('Docker OperatingSystem selects a native shared pool and retains the Desktop reading', () => {
  const stats = '{"Name":"rezics-qa-first-fuseki-1","MemUsage":"2GiB / 7GiB"}';
  const meminfo = `MemAvailable: ${14 * GiB / 1024} kB\n`;
  const desktop = { vmTotal: 24 * GiB, vmUsed: 2 * GiB, hostAvailable: 14 * GiB };
  expect(parseMemoryReading(String(24 * GiB), stats, meminfo, 'Docker Desktop')).toEqual(desktop);
  expect(parseMemoryReading(String(64 * GiB), stats, meminfo, 'Fedora Linux 44')).toEqual({
    ...desktop, vmTotal: 64 * GiB, engine: 'native', containers: { 'rezics-qa-first-fuseki-1': 2 * GiB },
  });
  expect(() => parseMemoryReading(String(64 * GiB), stats, meminfo, '')).toThrow('OperatingSystem');
});

for (const entry of ['wait', 'startup'] as const) {
  test(`${entry}: native admission charges containers and runner once, with one reserve`, async () => {
    let now = 0;
    const lines: string[] = [];
    const options = { root, env: { REZICS_STACK_PROFILE: 'qa' }, deadline: 100, now: () => now,
      pollMs: 10, read: async () => ({ ...native, hostAvailable: native.hostAvailable - (now === 0 ? 1 : 0) }),
      sleep: async (ms: number) => { now += ms; }, announce: (line: string) => { lines.push(line); } };
    if (entry === 'wait') await waitForMemory(need, options);
    else await withMemoryStartup(need, options, () => { expect(now).toBe(10); });
    expect(now).toBe(10);
    expect(lines.at(-1)).toStartWith('Admitted; QA memory: native Docker Engine on host needs 5.00 GiB containers + 1.00 GiB host + 8.00 GiB reserve');
    expect(lines.at(-1)).toContain('available 14.00 GiB');
  });

  test(`${entry}: a native host shortage refuses even with ample Docker MemTotal`, async () => {
    let now = 0;
    const options = { root, env: { REZICS_STACK_PROFILE: 'qa' }, deadline: 20, now: () => now,
      pollMs: 10, read: async () => ({ ...native, hostAvailable: 13 * GiB }),
      sleep: async (ms: number) => { now += ms; }, announce: () => {} };
    const work = entry === 'wait' ? waitForMemory(need, options)
      : withMemoryStartup(need, options, () => { throw new Error('must not start'); });
    await expect(work).rejects.toThrow('Memory admission deadline reached');
  });

  test(`${entry}: Desktop still admits against separate VM and host budgets`, async () => {
    const lines: string[] = [];
    const options = { root, env: { REZICS_STACK_PROFILE: 'qa' }, deadline: 100, now: () => 0,
      read: async () => ({ vmTotal: 24 * GiB, vmUsed: 17 * GiB, hostAvailable: 9 * GiB }),
      announce: (line: string) => { lines.push(line); } };
    if (entry === 'wait') await waitForMemory(need, options);
    else await withMemoryStartup(need, options, () => {});
    expect(lines.at(-1)).toContain('Docker VM needs 5.00 GiB + 2.00 GiB reserve, free 7.00 GiB');
    expect(lines.at(-1)).toContain('host needs 1.00 GiB + 8.00 GiB reserve, available 9.00 GiB');
  });
}

for (const entry of ['startup', 'wait'] as const) {
for (const resident of [0, 2, 5, 6]) {
  test(`native ${entry} subtracts only unresident admitted caps with ${resident} GiB resident`, async () => {
    mkdirSync(join(root, '.temp'), { recursive: true });
    const dir = mkdtempSync(join(root, '.temp', 'memory-native-'));
    directories.push(dir);
    writeFileSync(join(dir, 'qa-startup-concurrency'), '2');
    const state = new Database(':memory:');
    let now = 0;
    const lines: string[] = [];
    const options = { root, state, project: 'rezics-qa-first', deadline: 100_000, now: () => now,
      env: { REZICS_STACK_PROFILE: 'qa', GOAL_QA_SLOT_DIRECTORY: join(dir, 'slots') },
      read: async () => ({ ...native, hostAvailable: 21 * GiB - resident * GiB,
        containers: { 'rezics-qa-first-fuseki-1': resident * GiB,
          'rezics-qa-first-other-fuseki-1': 50 * GiB, 'unrelated': 50 * GiB } }),
      sleep: async (ms: number) => { now += ms; },
      readingMaxAgeMs: 0, announce: (line: string) => { lines.push(line); } };
    let finish!: () => void;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const first = withMemoryStartup(need, options, async () => { ready(); await held; });
    await started;
    now = 31_000;
    try {
      if (entry === 'startup') await withMemoryStartup(need, { ...options, project: 'rezics-qa-second' }, () => {});
      else await waitForMemory(need, options);
      expect(lines.at(-1)).toContain(`available ${(resident > 5 ? 14 : 15).toFixed(2)} GiB`);
    } finally { finish(); await first; state.close(true); }
  });
}
}

test('native messages validate all numeric measurements and apply the larger reserve once', () => {
  expect(measuredAdmissionMessage({ ...need, vmReserve: 10 * GiB }, native)).toContain('+ 10.00 GiB reserve');
  expect(() => measuredAdmissionMessage(need, { ...native, containers: { bad: NaN } })).toThrow('Invalid memory reading');
});

test('Docker startup advice names the selected engine, including a stopped Desktop context', () => {
  expect(dockerUnavailableMessage({ DOCKER_CONTEXT: 'default' })).toContain('sudo systemctl start docker');
  expect(dockerUnavailableMessage({ DOCKER_CONTEXT: 'desktop-linux' })).toContain('systemctl --user start docker-desktop');
  expect(dockerUnavailableMessage({ DOCKER_HOST: 'unix:///var/run/docker.sock' })).toContain('sudo systemctl start docker');
  expect(dockerUnavailableMessage({ DOCKER_HOST: 'unix:///home/test/.docker/desktop/docker.sock' }))
    .toContain('systemctl --user start docker-desktop');
  expect(dockerUnavailableMessage({ DOCKER_CONTEXT: 'default' }, 'Docker Desktop'))
    .toContain('systemctl --user start docker-desktop');
});
