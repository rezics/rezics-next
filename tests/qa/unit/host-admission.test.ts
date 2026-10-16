import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireHeavy, qaSlotAdmission, withSlot } from '../../../scripts/goal/qa-slots.ts';
import { GiB } from '../../../scripts/qa/memory-admission.ts';
import { admittedCommandBudgetEnv, BUILD_ADMISSION_GIB, hostAdmissionUsage, parseHostAdmissionArgs, runHostAdmission, SERIAL_ADMISSION_GIB } from '../../../scripts/qa/host-admission.ts';

const root = resolve(import.meta.dir, '../../..');
const scratch = join(root, '.temp');
const qaEnv = { REZICS_STACK_PROFILE: 'qa' };
const host = (available: number) => ({ vmTotal: 0, vmUsed: 0, hostAvailable: available });

test('host admission arguments require a positive gibibyte need and a command', () => {
  expect(parseHostAdmissionArgs(['--gib', '4', '--', 'tsc', '--noEmit'])).toEqual({
    gib: 4, cpu: false, command: ['tsc', '--noEmit'],
  });
  expect(parseHostAdmissionArgs(['--cpu', '--gib', '4', '--', 'tsc'])).toEqual({ gib: 4, cpu: true, command: ['tsc'] });
  expect(parseHostAdmissionArgs(['--gib', '3.5', '--', 'tsc']).gib).toBe(3.5);
  for (const args of [
    [],
    ['--gib', '4'],
    ['--gib', '4', '--'],
    ['tsc', '--', 'tsc'],
    ['--gib', '0', '--', 'tsc'],
    ['--gib', '-1', '--', 'tsc'],
    ['--gib', '4GiB', '--', 'tsc'],
  ]) {
    expect(() => parseHostAdmissionArgs(args)).toThrow();
  }
  expect(() => parseHostAdmissionArgs(['--gib', '0', '--', 'tsc'])).toThrow('positive number of gibibytes');
  expect(() => parseHostAdmissionArgs([])).toThrow(hostAdmissionUsage);
});

test('host admission waits while the host is short, then runs once and returns the command status', async () => {
  let now = 0, reads = 0, runs = 0;
  const boundary = 2 * GiB + 8 * GiB;
  const messages: string[] = [];
  const status = await runHostAdmission(2, ['tsc', '--noEmit'], {
    env: qaEnv, deadline: 30, now: () => now, sleep: async ms => { now += ms; }, pollMs: 10,
    announce: message => messages.push(message),
    read: async () => {
      expect(runs).toBe(0);
      reads++;
      return host(boundary - (reads === 1 ? 1 : 0));
    },
    run: async command => {
      expect(command).toEqual(['tsc', '--noEmit']);
      runs++;
      return 3;
    },
  });
  expect(status).toBe(3);
  expect(runs).toBe(1);
  expect(reads).toBe(2);
  expect(now).toBe(10);
  expect(messages[0]).toStartWith('Waiting;');
  expect(messages[0]).toContain('host needs 2.00 GiB + 8.00 GiB reserve, available');
  expect(messages[1]).toStartWith('Admitted;');
  expect(messages[1]).toContain('host needs 2.00 GiB + 8.00 GiB reserve, available 10.00 GiB');
});

test('host admission keeps a configured reserve and does not start after the deadline', async () => {
  let now = 0, runs = 0;
  const messages: string[] = [];
  await expect(runHostAdmission(4, ['tsc'], {
    env: { ...qaEnv, REZICS_QA_HOST_RESERVE_GIB: '9' }, deadline: 15, now: () => now,
    sleep: async ms => { now += ms; }, pollMs: 10, announce: message => messages.push(message),
    read: async () => host(12 * GiB),
    run: async () => { runs++; return 0; },
  })).rejects.toThrow('host needs 4.00 GiB + 9.00 GiB reserve, available 12.00 GiB');
  expect(runs).toBe(0);
  expect(now).toBe(15);
  expect(messages.every(message => message.startsWith('Waiting;'))).toBe(true);
});

test('memory wait does not consume the admitted command budget or pass it to grandchildren', async () => {
  let reads = 0;
  const started = Date.now();
  const status = await runHostAdmission(4, ['bun', '-e',
    `if (process.env.${admittedCommandBudgetEnv} !== undefined) process.exit(7);`], {
    env: { ...process.env, ...qaEnv, [admittedCommandBudgetEnv]: '200' },
    deadline: started + 5_000, pollMs: 300, announce: () => {},
    read: async () => host(++reads === 1 ? 0 : 12 * GiB),
  });
  expect(Date.now() - started).toBeGreaterThan(200);
  expect(reads).toBe(2);
  expect(status).toBe(0);
});

test('host admission runs the command without measuring memory outside a local Goal run', async () => {
  const dir = mkdtempSync(join(scratch, 'host-admission-'));
  const seen: (readonly string[])[] = [];
  const probe = {
    read: async () => { throw new Error('measured memory'); },
    announce: () => { throw new Error('printed admission'); },
    sleep: async () => { throw new Error('waited'); },
    now: () => { throw new Error('read a clock'); },
    pollMs: 0, deadline: -1,
    run: async (command: readonly string[]) => { seen.push(command); return 4; },
  };
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    expect(await runHostAdmission(2, ['tsc', '--noEmit'], { ...probe, root: dir, env: {} })).toBe(4);
    expect(await runHostAdmission(2, ['tsc'], {
      ...probe,
      env: { REZICS_STACK_PROFILE: 'dev', GOAL_TASK_ID: 'worker', REZICS_QA_HOST_RESERVE_GIB: 'invalid',
        REZICS_QA_MEMORY_DEADLINE: 'invalid' },
    })).toBe(4);
    expect(seen).toEqual([['tsc', '--noEmit'], ['tsc']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the host admission command returns the child status and rejects a bad invocation', () => {
  const env = { ...process.env, REZICS_STACK_PROFILE: 'dev' };
  const script = join(root, 'scripts/qa/host-admission.ts');
  const child = spawnSync('bun', [script, '--gib', '1', '--', 'bun', '-e', 'process.exit(3)'], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000,
  });
  expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(3);
  expect(`${child.stdout}\n${child.stderr}`).not.toContain('QA memory');
  const usage = spawnSync('bun', [script, '--gib', '0', '--', 'true'], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000,
  });
  expect(usage.status).not.toBe(0);
  expect(usage.stderr).toContain('positive number of gibibytes');
});

test('a large need runs again under the host-wide lock, and a small or already locked one runs directly', async () => {
  const lock = join(scratch, `large-admission-${process.pid}.lock`);
  const seen: (readonly string[])[] = [];
  const options = {
    deadline: 30, now: () => 0, sleep: async () => {}, pollMs: 10, announce: () => {},
    read: async () => host(64 * GiB), run: async (command: readonly string[]) => { seen.push(command); return 0; },
  };
  try {
    await runHostAdmission(SERIAL_ADMISSION_GIB, ['tsc', '--noEmit'], { ...options, env: qaEnv, serialLock: lock });
    expect(seen[0]!.slice(0, 4)).toEqual(['flock', lock, 'env', 'REZICS_QA_SERIAL_ADMISSION=1']);
    expect(seen[0]!.slice(-5)).toEqual(['--gib', String(SERIAL_ADMISSION_GIB), '--', 'tsc', '--noEmit']);
    await runHostAdmission(SERIAL_ADMISSION_GIB - 0.5, ['tsc'], { ...options, env: qaEnv, serialLock: lock });
    expect(seen[1]).toEqual(['tsc']);
    await runHostAdmission(7, ['tsc'], { ...options, env: { ...qaEnv, REZICS_QA_SERIAL_ADMISSION: '1' }, serialLock: lock });
    expect(seen[2]).toEqual(['tsc']);
    await runHostAdmission(7, ['tsc'], { ...options, env: qaEnv });
    expect(seen[3]).toEqual(['tsc']);
  } finally { rmSync(lock, { force: true }); }
});

test('long builds are admitted below the size that takes the serial turn', () => {
  expect(BUILD_ADMISSION_GIB).toBeLessThan(SERIAL_ADMISSION_GIB);
});

test('the serial lock wait preserves the budget for the finally admitted command', async () => {
  const dir = mkdtempSync(join(scratch, 'serial-budget-'));
  const lock = join(dir, 'admission.lock');
  const holder = Bun.spawn(['flock', lock, 'bun', '-e',
    "console.log('held'); setTimeout(() => {}, 1_200);"], { stdout: 'pipe', stderr: 'inherit' });
  try {
    const reader = holder.stdout.getReader();
    const acquired = await reader.read();
    expect(new TextDecoder().decode(acquired.value)).toContain('held');
    reader.releaseLock();
    const started = Date.now();
    const status = await runHostAdmission(SERIAL_ADMISSION_GIB, ['bun', '-e',
      `if (process.env.${admittedCommandBudgetEnv} !== undefined) process.exit(7);`], {
      serialLock: lock,
      env: { ...process.env, ...qaEnv, REZICS_QA_HOST_RESERVE_GIB: '0', [admittedCommandBudgetEnv]: '500' },
    });
    expect(Date.now() - started).toBeGreaterThan(500);
    expect(status).toBe(0);
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const command of [
  ['bun', 'scripts/qa/test.ts', 'tests/qa/integration/discovery-incremental.test.ts', 'scripts/api/answer-records.guard.test.ts'],
  ['worker-check', 'tests/qa/integration/discovery-incremental.test.ts'],
]) {
  test(`a waiting harness holds no ordinary slot: ${command[0]}`, async () => {
    const dir = mkdtempSync(join(scratch, 'waiting-harness-'));
    try {
      expect(await withSlot(command, false, undefined, {
        slotDirectory: dir, slots: 1, reap: () => {},
        runCommand: async (_command, env, start) => {
          start();
          expect(env.GOAL_IN_SLOT).toBe('0');
          expect(existsSync(join(dir, '0'))).toBe(false);
          return 0;
        },
      })).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('ordinary waiters retain FIFO order and a dead waiter gives up its place', () => {
  const dir = mkdtempSync(join(scratch, 'ordinary-order-'));
  let now = 0;
  const live = new Set([11, 12, 13]);
  const options = (pid: number) => ({ pid, now: () => now++, alive: (candidate: number) => live.has(candidate),
    env: { GOAL_ID: 'program' }, workerGoals: () => [] });
  const first = qaSlotAdmission(dir, 1, options(11));
  const second = qaSlotAdmission(dir, 1, options(12));
  const third = qaSlotAdmission(dir, 1, options(13));
  try {
    expect(third.acquire(0)).toBe('held');
    const one = first.acquire(0); expect(one).not.toBe('held');
    if (one !== 'held') one.release();
    live.delete(12);
    const three = third.acquire(0); expect(three).not.toBe('held');
    if (three !== 'held') three.release();
  } finally { first.release(); second.release(); third.release(); rmSync(dir, { recursive: true, force: true }); }
});

test('a heavy harness waits for memory before holding its heavy turn', async () => {
  const dir = mkdtempSync(join(scratch, 'deferred-heavy-'));
  try {
    expect(await withSlot(['bun', 'scripts/qa/cli.ts', '--tier', 'unit', '--beside-workers'], true, undefined, {
      slotDirectory: dir, env: { GOAL_ID: 'program' }, reap: () => {},
      runCommand: async (_command, env, start) => {
        start();
        expect(env.GOAL_QA_DEFERRED_HEAVY).toBe('1');
        expect(existsSync(join(dir, 'heavy'))).toBe(false);
        return 0;
      },
    })).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('heavy waiters across Goals take arrival order rather than rotating past an older Goal', async () => {
  const dir = mkdtempSync(join(scratch, 'heavy-order-'));
  let now = 0;
  const live = new Set([11, 12, 13]);
  const options = (pid: number, goal: string) => ({ lockDir: join(dir, 'heavy'), pid, goal,
    bindExit: false, now: () => now++, alive: (candidate: number) => live.has(candidate), announce: () => {} });
  try {
    const release = await acquireHeavy(['first'], options(11, 'api'));
    let wake!: () => void;
    let sleeping!: () => void;
    const paused = new Promise<void>(resolve => { sleeping = resolve; });
    const older = acquireHeavy(['older'], { ...options(12, 'api'), sleep: async () => {
      sleeping(); await new Promise<void>(resolve => { wake = resolve; });
    } });
    await paused;
    release();
    await expect(acquireHeavy(['newer'], { ...options(13, 'program'), deadline: now,
      sleep: async () => { throw new Error('Must not sleep past deadline'); } })).rejects.toThrow('deadline');
    wake(); (await older)();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
