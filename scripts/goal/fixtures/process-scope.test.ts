import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { processAlive } from '../../qa/process/identity.ts';
import { killWorktreeProcesses } from '../goalctl.ts';

const fixtureDeadlineMs = 180_000;

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + fixtureDeadlineMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`process fixture did not settle within ${fixtureDeadlineMs}ms`);
    await Bun.sleep(20);
  }
}

async function fixture(marked: boolean) {
  const root = mkdtempSync(join(import.meta.dir, '../../../.temp/process-scope-'));
  const children: ChildProcess[] = [];
  const workers: { worker: number; child: number }[] = [];
  const readyPaths: string[] = [];
  const cleanup = () => {
    for (const path of readyPaths) {
      if (!existsSync(path)) continue;
      const ready = JSON.parse(readFileSync(path, 'utf8')) as { worker: number; child: number };
      for (const pid of [ready.worker, ready.child]) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    for (const child of children) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  };
  try {
    const worktrees = [join(root, 'first'), join(root, 'second')];
    for (const worktree of worktrees) {
      const ready = join(worktree, '.temp/ready');
      mkdirSync(ready, { recursive: true });
      const readyPath = join(ready, 'G-001');
      readyPaths.push(readyPath);
      const env: NodeJS.ProcessEnv = { ...process.env, GOAL_TASK_ID: 'G-001', GOAL_SLEEP_READY_DIR: ready };
      delete env.GOAL_WORKER_SCRIPT;
      delete env.GOAL_WORKER_LOG;
      if (marked) env.GOAL_WORKTREE = worktree;
      else delete env.GOAL_WORKTREE;
      const child = spawn(process.execPath, [join(import.meta.dir, 'sleep-worker.ts')], {
        cwd: worktree, detached: true, stdio: 'ignore', env,
      });
      children.push(child);
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
