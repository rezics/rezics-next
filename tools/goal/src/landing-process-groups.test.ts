import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateRunner, processGroupRunner } from './merge.ts';
import { landingAffectedChecks } from './merge-train.ts';

const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
  } catch {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function expectStopped(pid: number) {
  for (let attempt = 0; attempt < 20 && alive(pid); attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(alive(pid)).toBe(false);
}

test('a landing command cannot leave a background child alive after its leader exits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-process-group-'));
  try {
    const pidFile = join(directory, 'child.pid');
    const runner = gateRunner(10_000);
    const result = await runner(
      ['sh', '-c', `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`],
      directory,
      join(directory, 'command.log'),
    );
    expect(result.passed).toBe(true);
    await expectStopped(Number(readFileSync(pidFile, 'utf8').trim()));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an affected check uses a process group too, and timeout kills its child', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-process-group-timeout-'));
  try {
    const pidFile = join(directory, 'child.pid');
    const runner = processGroupRunner(100);
    const result = await runner(
      ['sh', '-c', `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`],
      directory,
      join(directory, 'command.log'),
    );
    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
    await expectStopped(Number(readFileSync(pidFile, 'utf8').trim()));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('train fixtures opt out of repository affected and sibling defaults', () => {
  expect(process.env.GOAL_TEST_ENVIRONMENT).toBe('1');
  expect(landingAffectedChecks(['services/kernel/src/file.ts'], true, undefined)).toEqual([]);
  expect(
    landingAffectedChecks(
      ['services/kernel/src/file.ts'],
      true,
      [{ paths: ['services/kernel/**'], command: ['test-command'] }],
    ),
  ).toEqual([{ paths: ['services/kernel/**'], command: ['test-command'] }]);
});
