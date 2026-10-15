import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { processAlive } from '../../qa/process/identity.ts';
import { killWorktreeProcesses } from '../goalctl.ts';
import { processRunning } from '../../../tests/qa/support/process-liveness.ts';
import { fixtureProcessScope } from './process-scope.ts';

const fixtureDeadlineMs = 180_000;
const cleanups: Array<() => void> = [];
afterEach(() => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0)) {
    try { cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Process fixture cleanup failed');
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + fixtureDeadlineMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`process fixture did not settle within ${fixtureDeadlineMs}ms`);
    await Bun.sleep(20);
  }
}

async function fixture(marked: boolean) {
  const root = mkdtempSync(join(import.meta.dir, '../../../.temp/process-scope-'));
  const scope = fixtureProcessScope();
  const workers: { worker: number; child: number }[] = [];
  const cleanup = () => {
    scope.cleanup();
    rmSync(root, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  try {
    const worktrees = [join(root, 'first'), join(root, 'second')];
    for (const worktree of worktrees) {
      const ready = join(worktree, '.temp/ready');
      mkdirSync(ready, { recursive: true });
      const readyPath = join(ready, 'G-001');
      const env: NodeJS.ProcessEnv = { ...process.env, ...scope.env, GOAL_TASK_ID: 'G-001', GOAL_SLEEP_READY_DIR: ready };
      delete env.GOAL_WORKER_SCRIPT;
      delete env.GOAL_WORKER_LOG;
      if (marked) env.GOAL_WORKTREE = worktree;
      else delete env.GOAL_WORKTREE;
      const child = spawn(process.execPath, [join(import.meta.dir, 'sleep-worker.ts')], {
        cwd: worktree, detached: true, stdio: 'ignore', env,
      });
      let failure: Error | undefined;
      child.once('error', error => { failure = error; });
      await until(() => {
        if (failure) throw failure;
        return existsSync(readyPath);
      });
      const worker = JSON.parse(readFileSync(readyPath, 'utf8')) as { worker: number; child: number };
      await until(() => processAlive({ pid: worker.worker }) && processAlive({ pid: worker.child }));
      workers.push(worker);
    }
    return { worktrees, workers, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

test('task cleanup scopes identical task IDs by originating worktree after descendants change cwd', async () => {
  const f = await fixture(true);
  try {
    const [first, second] = f.workers;
    expect(killWorktreeProcesses(f.worktrees[0]!, 'G-001')).toBe(2);
    await until(() => !processAlive({ pid: first!.worker }) && !processAlive({ pid: first!.child }));
    expect(processAlive({ pid: second!.worker })).toBe(true);
    expect(processAlive({ pid: second!.child })).toBe(true);
  } finally { f.cleanup(); }
}, 240_000);

test('legacy task cleanup only signals matching workers still inside the requested worktree', async () => {
  const f = await fixture(false);
  try {
    const [first, second] = f.workers;
    expect(killWorktreeProcesses(f.worktrees[0]!, 'G-001')).toBe(1);
    await until(() => !processAlive({ pid: first!.worker }));
    expect(processAlive({ pid: first!.child })).toBe(true);
    expect(processAlive({ pid: second!.worker })).toBe(true);
    expect(processAlive({ pid: second!.child })).toBe(true);
  } finally { f.cleanup(); }
}, 240_000);

for (const failure of ['assertion', 'timeout'] as const) {
  test(`fixture cleanup stops detached workers and their children after a test ${failure}`, () => {
    const scratch = join(import.meta.dir, '../../../.temp/process-scope-tests');
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, 'case-'));
    const scope = fixtureProcessScope();
    const ready = join(directory, 'G-001');
    const harness = join(directory, 'cleanup.test.ts');
    writeFileSync(harness, `import { afterEach, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fixtureProcessScope } from ${JSON.stringify(join(import.meta.dir, 'process-scope.ts'))};
const scope = fixtureProcessScope(${JSON.stringify(scope.env.GOAL_TEST_PROCESS_SCOPE)});
afterEach(() => scope.cleanup());
test('failing fixture', async () => {
  const worker = spawn(process.execPath, [${JSON.stringify(join(import.meta.dir, 'sleep-worker.ts'))}], {
    detached: true, stdio: 'ignore', env: { ...process.env, ...scope.env,
      GOAL_SLEEP_READY_DIR: ${JSON.stringify(directory)}, GOAL_TASK_ID: 'G-001' },
  });
  worker.unref();
  while (!existsSync(${JSON.stringify(ready)})) await Bun.sleep(10);
  ${failure === 'assertion' ? "throw new Error('fixture assertion failed before PID registration');" : 'await new Promise(() => {});'}
}, 2000);
`);
    try {
      const result = spawnSync(process.execPath, ['test', harness], {
        encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', env: { ...process.env, ...scope.env },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(existsSync(ready), result.stderr).toBe(true);
      const pids = JSON.parse(readFileSync(ready, 'utf8')) as { worker: number; child: number };
      expect(processRunning(pids.worker)).toBe(false);
      expect(processRunning(pids.child)).toBe(false);
    } finally {
      // A broken cleanup under test must not leak its own reproduction, even before readiness.
      scope.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
