import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptEnvironment } from './launch.ts';
import { gateEnvironment } from './merge.ts';
import type { Task } from './types.ts';

test('a worker environment leaves affected-test selection to the check runner and neutralizes the debuginfod path', () => {
  expect(attemptEnvironment({ id: 'task', base: 'abc123' }, { attempt: 2 })).toEqual({
    GOAL_TASK_ID: 'task',
    GOAL_ATTEMPT: '2',
    DEBUGINFOD_IMA_CERT_PATH: 'none',
    MOZ_GMP_PATH: 'none',
    EDITOR: 'nano',
  });
});

test('a worker environment names the acceptance requirements its brief lists, which admit a walk stack', () => {
  const brief = { acceptance: { requires: ['native', 'root'] } } as unknown as Task['brief'];
  expect(attemptEnvironment({ id: 'task', base: 'abc123', brief }, { attempt: 2 })).toEqual({
    GOAL_TASK_ID: 'task',
    GOAL_ATTEMPT: '2',
    GOAL_ACCEPTANCE_REQUIRES: 'native,root',
    DEBUGINFOD_IMA_CERT_PATH: 'none',
    MOZ_GMP_PATH: 'none',
    EDITOR: 'nano',
  });
});

function state(withHosts: boolean): { directory: string; remove: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'goal-state-'));
  mkdirSync(directory, { recursive: true });
  if (withHosts) writeFileSync(join(directory, 'remote-check-hosts.json'), '{"hosts":[]}');
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

test('worker and promotion gate environments carry KERNEL_CHECK_REMOTE when the local hosts file exists', () => {
  const present = state(true);
  const absent = state(false);
  try {
    const hosts = join(present.directory, 'remote-check-hosts.json');
    expect(attemptEnvironment({ id: 'task', base: 'abc123' }, { attempt: 2 }, present.directory)).toEqual({
      GOAL_TASK_ID: 'task',
      GOAL_ATTEMPT: '2',
      DEBUGINFOD_IMA_CERT_PATH: 'none',
      MOZ_GMP_PATH: 'none',
      EDITOR: 'nano',
      KERNEL_CHECK_REMOTE: hosts,
      GOAL_CHECK_WAIT_FILE: join(present.directory, 'runs', 'task', '2.check-wait'),
    });
    expect(attemptEnvironment({ id: 'task', base: 'abc123' }, { attempt: 2 }, absent.directory)).not.toHaveProperty(
      'KERNEL_CHECK_REMOTE',
    );
    expect(gateEnvironment({ PATH: '/bin' }, present.directory).KERNEL_CHECK_REMOTE).toBe(hosts);
    expect(gateEnvironment({ PATH: '/bin' }, absent.directory)).not.toHaveProperty('KERNEL_CHECK_REMOTE');
    // The hosts file is the control plane's configuration; a gate never inherits another selection.
    expect(gateEnvironment({ PATH: '/bin', KERNEL_CHECK_REMOTE: '/elsewhere' }, absent.directory)).not.toHaveProperty(
      'KERNEL_CHECK_REMOTE',
    );
  } finally {
    present.remove();
    absent.remove();
  }
});

test('check slot waits recorded beside the run log are summed', async () => {
  const { checkWaitMs } = await import('./launch.ts');
  const directory = mkdtempSync(join(tmpdir(), 'goal-wait-'));
  try {
    expect(checkWaitMs(join(directory, '1.jsonl'))).toBe(0);
    writeFileSync(join(directory, '1.check-wait'), '1000\n2500\nnot a number\n');
    expect(checkWaitMs(join(directory, '1.jsonl'))).toBe(3500);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
