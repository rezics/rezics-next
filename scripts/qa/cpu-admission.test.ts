import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpuCommandLimit, withCpuAdmission, type CpuAdmissionOptions } from './cpu-admission.ts';
import { parseHostAdmissionArgs, runHostAdmission } from './host-admission.ts';
import { GiB } from './memory-admission.ts';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(): CpuAdmissionOptions {
  const root = resolve(import.meta.dir, '../..');
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/cpu-admission-'));
  directories.push(directory);
  return { root, stateFile: join(directory, 'admission.sqlite'),
    env: { GOAL_QA_SLOT_DIRECTORY: join(directory, 'slots') }, processors: 32,
    deadline: Date.now() + 5000, readPressure: () => 0, announce: () => {}, pollMs: 1 };
}

test.each([[1, 1], [8, 1], [16, 1], [32, 2], [64, 4]])('CPU count %i allows %i heavy commands', (count, limit) => {
  expect(cpuCommandLimit(count)).toBe(limit);
});

test('five simultaneous commands keep lifetime permits, wait visibly, and all finish', async () => {
  const options = fixture();
  let active = 0;
  let peak = 0;
  const lines: string[] = [];
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => withCpuAdmission({ ...options,
    announce: line => { lines.push(line); } }, async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    return index;
  })));
  expect(results).toEqual([0, 1, 2, 3, 4]);
  expect(peak).toBe(2);
  expect(lines.filter(line => line.startsWith('CPU admitted:'))).toHaveLength(5);
  expect(lines.filter(line => line.startsWith('Waiting for CPU admission:')).length).toBeGreaterThanOrEqual(3);
});

test('an idle host runs immediately and a failed command releases its permit', async () => {
  const options = { ...fixture(), processors: 1, sleep: async () => { throw new Error('unexpected wait'); } };
  await expect(withCpuAdmission(options, async () => { throw new Error('compiler failed'); })).rejects.toThrow('compiler failed');
  expect(await withCpuAdmission(options, async () => 0)).toBe(0);
});

test('current CPU pressure stops starts until it recovers', async () => {
  let now = 0;
  const lines: string[] = [];
  const options = { ...fixture(), deadline: 100, now: () => now, pollMs: 10,
    readPressure: () => now < 20 ? 75 : 0,
    sleep: async (ms: number) => { now += ms; }, announce: (line: string) => { lines.push(line); } };
  await withCpuAdmission(options, async () => { expect(now).toBe(20); });
  expect(lines[0]).toContain('CPU pressure some avg10 75.00%, limit 12%');
  expect(lines.at(-1)).toStartWith('CPU admitted: 1/2');
});

test('without PSI, normalized load prevents starts and a deadline fails closed', async () => {
  let now = 0;
  let ran = false;
  const options = { ...fixture(), deadline: 20, now: () => now, pollMs: 10,
    readPressure: () => undefined, readLoad: () => 75,
    sleep: async (ms: number) => { now += ms; } };
  await expect(withCpuAdmission(options, async () => { ran = true; })).rejects.toThrow('CPU admission deadline reached');
  expect(ran).toBe(false);
  expect(now).toBe(20);
});

test('waiting commands reread the shared QA pressure limit', async () => {
  const options = fixture();
  const policy = join(options.env!.GOAL_QA_SLOT_DIRECTORY!, '../qa-cpu-pressure-limit');
  writeFileSync(policy, '3');
  let waited = false;
  await withCpuAdmission({ ...options, readPressure: () => 5, sleep: async () => {
    waited = true;
    writeFileSync(policy, '10');
  } }, async () => { expect(waited).toBe(true); });
});

test('a stale permit with a reused PID cannot block a new command', async () => {
  const options = fixture();
  const db = new Database(options.stateFile!);
  db.exec('CREATE TABLE cpu_commands (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, start_time TEXT NOT NULL)');
  db.query('INSERT INTO cpu_commands VALUES (?, ?, ?)').run('stale', process.pid, 'wrong-start');
  db.close();
  await withCpuAdmission({ ...options, processors: 1 }, async () => {});
  const checked = new Database(options.stateFile!);
  expect(checked.query('SELECT * FROM cpu_commands').all()).toEqual([]);
  checked.close();
});

test('CPU opt-in preserves the memory-only CLI and command arguments', () => {
  expect(parseHostAdmissionArgs(['--gib', '2', '--', 'bun', '--cpu'])).toEqual({ gib: 2, cpu: false, command: ['bun', '--cpu'] });
  expect(parseHostAdmissionArgs(['--cpu', '--gib', '2', '--', 'bun', 'check'])).toEqual({ gib: 2, cpu: true, command: ['bun', 'check'] });
});

test('host admission waits for CPU before running a compiler and keeps its exit code', async () => {
  let now = 0;
  const cpuOptions = { ...fixture(), deadline: 100, now: () => now, pollMs: 10,
    readPressure: () => now === 0 ? 50 : 0, sleep: async (ms: number) => { now += ms; } };
  const code = await runHostAdmission(1.5, ['bun', 'check'], { cpu: true, cpuOptions,
    env: { REZICS_STACK_PROFILE: 'qa' }, deadline: 100, now: () => now, announce: () => {},
    read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: 64 * GiB }),
    run: async () => { expect(now).toBe(10); return 17; } });
  expect(code).toBe(17);
});
