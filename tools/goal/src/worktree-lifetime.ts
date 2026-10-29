import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { WorkerStore } from './store.ts';
import type { Settings, Task } from './types.ts';
import { acquireDirectoryLease, LeaseHeldError, type DirectoryLease } from './lease.ts';
import { pruneStores } from './shared-dependencies.ts';

export const IO_PRESSURE_LIMIT = 20;
export type LifetimeRuntime = {
  pressure: () => number | null;
  sleep: (ms: number) => Promise<void>;
  command: (command: string, args: string[], cwd: string) => void;
};
const runtime: LifetimeRuntime = {
  pressure: () => {
    try {
      const line = readFileSync('/proc/pressure/io', 'utf8')
        .split('\n')
        .find((row) => row.startsWith('some '));
      const value = /(?:^| )avg10=([\d.]+)/.exec(line ?? '')?.[1];
      return value === undefined ? null : Number(value);
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  command: (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `${command} exited ${result.status}`);
  },
};

const finished = new Set(['integrated', 'merged', 'cancelled']);
const protectedStates = new Set(['running', 'landing', 'ready', 'held', 'stopped']);
export async function removeFinishedWorktree(
  settings: Settings,
  store: WorkerStore,
  io: LifetimeRuntime = runtime,
): Promise<string | null> {
  const lease = (() => {
    try {
      return acquireDirectoryLease(join(settings.stateDirectory, 'leases', 'worktree-lifetime'));
    } catch (e) {
      if (e instanceof LeaseHeldError) return null;
      throw e;
    }
  })();
  if (!lease) return null;
  try {
    const candidates = store
      .tasks()
      .filter((task) => finished.has(task.state) && !protectedStates.has(task.state))
      .sort((a, b) => a.sequence - b.sequence);
    const roots = [...new Set([settings.worktreeRoot, join(settings.mainCheckout, '.temp/worktrees')])];
    let candidate: Task | undefined;
    let taskLease: DirectoryLease | undefined;
    for (const task of candidates) {
      if (!roots.some((root) => task.worktree === join(root, task.id) && existsSync(task.worktree))) continue;
      try {
        taskLease = acquireDirectoryLease(join(settings.stateDirectory, 'leases', task.id));
      } catch (error) {
        if (error instanceof LeaseHeldError) continue;
        throw error;
      }
      const current = store.task(task.id);
      if (!finished.has(current.state) || protectedStates.has(current.state)) {
        taskLease.release();
        taskLease = undefined;
        continue;
      }
      candidate = current;
      break;
    }
    if (!candidate) {
      // A stale Git registration is harmless; pruning is also what completes a manually removed backlog entry.
      io.command('ionice', ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'prune'], settings.mainCheckout);
      return null;
    }
    try {
      while ((io.pressure() ?? 0) > IO_PRESSURE_LIMIT) await io.sleep(1000);
      if (existsSync(candidate.worktree)) {
        try {
          io.command(
            'ionice',
            ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'remove', '--force', candidate.worktree],
            settings.mainCheckout,
          );
        } catch (error) {
          if (existsSync(candidate.worktree)) throw error;
        }
      }
      io.command('ionice', ['-c', '3', 'nice', '-n', '19', 'git', 'worktree', 'prune'], settings.mainCheckout);
      pruneStores(join(dirname(candidate.worktree), '..', 'dependency-stores'), settings.worktreeRoot);
      return candidate.id;
    } finally {
      taskLease?.release();
    }
  } finally {
    lease.release();
  }
}
