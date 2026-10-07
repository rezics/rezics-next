import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GiB } from '../../../scripts/qa/memory-admission.ts';
import { hostAdmissionUsage, parseHostAdmissionArgs, runHostAdmission } from '../../../scripts/qa/host-admission.ts';

const root = resolve(import.meta.dir, '../../..');
const scratch = join(root, '.temp');
const qaEnv = { REZICS_STACK_PROFILE: 'qa' };
const host = (available: number) => ({ vmTotal: 0, vmUsed: 0, hostAvailable: available });

test('host admission arguments require a positive gibibyte need and a command', () => {
  expect(parseHostAdmissionArgs(['--gib', '4', '--', 'tsc', '--noEmit'])).toEqual({
    gib: 4, command: ['tsc', '--noEmit'],
  });
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
