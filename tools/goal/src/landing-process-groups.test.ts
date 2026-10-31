import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
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

test('stopping the train kills its active command group', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-process-group-stop-'));
  let train: ReturnType<typeof spawn> | undefined;
  try {
    const pidFile = join(directory, 'child.pid');
    const moduleUrl = new URL('./merge.ts', import.meta.url).href;
    const script = `import { processGroupRunner } from ${JSON.stringify(moduleUrl)}; await processGroupRunner()(['sh','-c',${JSON.stringify(`sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`)}],${JSON.stringify(directory)},${JSON.stringify(join(directory, 'command.log'))});`;
    train = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    await until(() => train!.pid !== undefined && existsSync(pidFile));
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    train.kill('SIGTERM');
    await new Promise<void>((resolve) => train!.once('close', () => resolve()));
    await expectStopped(childPid);
  } finally {
    train?.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('train fixtures opt out of repository affected and sibling defaults', () => {
  expect(process.env.REZICS_GOAL_TEST_ENVIRONMENT).toBe('1');
  expect(landingAffectedChecks(['services/kernel/src/file.ts'], true, undefined)).toEqual([]);
  expect(
    landingAffectedChecks(['services/kernel/src/file.ts'], true, [
      { paths: ['services/kernel/**'], command: ['test-command'] },
    ]),
  ).toEqual([{ paths: ['services/kernel/**'], command: ['test-command'] }]);
});

import { temporaryDirectory } from './test-support.ts';
import { runIntegrationChecks } from './merge-train.ts';

test('owned cancellation settles the selected gate group and leaves another lane group alive', async () => {
  const directory = temporaryDirectory();
  const main = new AbortController();
  const dev = new AbortController();
  const reason = new Error('fixture main proof preempted');
  const run = processGroupRunner(5000);
  const started: Promise<unknown>[] = [];
  try {
    const mainPid = join(directory.path, 'main.pid');
    const devPid = join(directory.path, 'dev.pid');
    const launch = (pidFile: string, signal: AbortSignal, name: string) =>
      run(
        ['sh', '-c', `sleep 30 & echo $! > '${pidFile}'; wait`],
        directory.path,
        join(directory.path, `${name}.log`),
        { signal },
      );
    const mainResult = launch(mainPid, main.signal, 'main').catch((error) => error);
    const devResult = launch(devPid, dev.signal, 'dev').catch((error) => error);
    started.push(mainResult, devResult);
    await until(() => existsSync(mainPid) && existsSync(devPid));
    const mainChild = Number(readFileSync(mainPid, 'utf8').trim());
    const devChild = Number(readFileSync(devPid, 'utf8').trim());
    main.abort(reason);
    expect(await mainResult).toBe(reason);
    await expectStopped(mainChild);
    expect(alive(devChild)).toBe(true);
    dev.abort(new Error('fixture cleanup'));
    await devResult;
    await expectStopped(devChild);
    const neverStarted = join(directory.path, 'never-started');
    await expect(
      run(['sh', '-c', `touch '${neverStarted}'`], directory.path, join(directory.path, 'never.log'), {
        signal: main.signal,
      }),
    ).rejects.toBe(reason);
    expect(existsSync(neverStarted)).toBe(false);
  } finally {
    main.abort(reason);
    dev.abort(reason);
    await Promise.allSettled(started);
    directory.close();
  }
});

test('owned cancellation waits for all proof siblings before returning a rejected check group', async () => {
  const directory = temporaryDirectory();
  const sibling = Promise.withResolvers<void>();
  let rejected = false;
  let settled = false;
  const reason = new Error('fixture cancellation');
  let running: Promise<void> | undefined;
  try {
    running = runIntegrationChecks(
      [['first'], ['sibling']],
      directory.path,
      join(directory.path, 'checks.log'),
      async (command) => {
        if (command[0] === 'first') throw reason;
        await sibling.promise;
        settled = true;
        return { passed: true, output: '', timedOut: false };
      },
    ).then(
      () => {
        throw new Error('Rejected proof must not turn green');
      },
      (error) => {
        expect(error).toBe(reason);
        expect(settled).toBe(true);
        rejected = true;
      },
    );
    await Bun.sleep(10);
    expect(rejected).toBe(false);
    sibling.resolve();
    await running;
    expect(rejected).toBe(true);
    expect(existsSync(join(directory.path, 'checks.log.check-0'))).toBe(true);
  } finally {
    sibling.resolve();
    await running;
    directory.close();
  }
});
