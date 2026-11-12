import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { openDb } from './db.ts';
import type { ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness, temporaryDirectory } from './test-support.ts';
import { WorkerStore } from './store.ts';
import { hasLiveProcessUnder } from './process.ts';
import { git } from './tasks.ts';
import { gitListsWorktree } from './task-workspace.ts';
import { runWorkerCommand } from './worker-commands.ts';
import {
  removeFinishedWorktree,
  strayWorktreeStatus,
  WORKTREE_SCAN_ENTRY_PAGE_SIZE,
  type LifetimeRuntime,
} from './worktree-lifetime.ts';

function fake(overrides: Partial<LifetimeRuntime> = {}): LifetimeRuntime {
  return {
    pressure: () => null,
    sleep: async () => {},
    command: (command, args, cwd) => {
      const actual = args.slice(args.indexOf('git') + 1);
      const result = Bun.spawnSync(['git', ...actual], { cwd, stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0 && !(actual[0] === 'worktree' && actual[1] === 'remove' && !existsSync(actual.at(-1)!)))
        throw new Error(new TextDecoder().decode(result.stderr));
      void command;
    },
    ...overrides,
  };
}

function plantReadOnlyGitCache(worktree: string): void {
  const cache = join(worktree, '.temp/remote-check-git-cache/sha1-fixture');
  mkdirSync(cache, { recursive: true });
  const manifest = join(cache, 'manifest.json');
  const pack = join(cache, 'objects.pack');
  writeFileSync(manifest, '{"head":"fixture"}');
  writeFileSync(pack, 'PACK');
  chmodSync(manifest, 0o444);
  chmodSync(pack, 0o444);
  chmodSync(cache, 0o555);
}

function dropGitEntry(worktree: string, mainCheckout: string): void {
  rmSync(join(worktree, '.git'), { recursive: true, force: true });
  git(mainCheckout, ['worktree', 'prune']);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('timed out');
}

test('removing a task worktree succeeds when it holds a read-only remote-check git cache', async () => {
  const h = harness();
  const task = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: task.id, attempt: 0 }, (row) => {
    row.state = 'integrated';
  });
  plantReadOnlyGitCache(task.worktree);
  try {
    expect(await removeFinishedWorktree(h.settings, h.store, fake())).toBe(task.id);
    expect(existsSync(task.worktree)).toBe(false);
    expect(gitListsWorktree(h.root, task.worktree)).toBe(false);
  } finally {
    if (existsSync(join(task.worktree, '.temp/remote-check-git-cache/sha1-fixture')))
      chmodSync(join(task.worktree, '.temp/remote-check-git-cache/sha1-fixture'), 0o755);
    h.dispose();
  }
}, 30_000);

test('a sweep removes no-.git leftovers for finished, stopped and unknown tasks, and keeps a live process cwd', async () => {
  const h = harness();
  const integrated = h.tasks.dispatch(h.briefFile);
  const stopped = h.tasks.dispatch(h.briefFile);
  const running = h.tasks.dispatch(h.briefFile);
  const occupied = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: integrated.id, attempt: 0 }, (row) => {
    row.state = 'integrated';
  });
  h.store.updateTask({ taskId: stopped.id, attempt: 0 }, (row) => {
    row.state = 'stopped';
  });
  h.store.updateTask({ taskId: running.id, attempt: 0 }, (row) => {
    row.state = 'running';
  });
  h.store.updateTask({ taskId: occupied.id, attempt: 0 }, (row) => {
    row.state = 'cancelled';
  });
  dropGitEntry(integrated.worktree, h.root);
  dropGitEntry(stopped.worktree, h.root);
  dropGitEntry(running.worktree, h.root);
  dropGitEntry(occupied.worktree, h.root);
  const unknown = join(h.settings.worktreeRoot, 'no-task-leftover');
  mkdirSync(unknown, { recursive: true });
  writeFileSync(join(unknown, 'junk'), 'x');
  const kept: string[] = [];
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: occupied.worktree,
    stdio: 'ignore',
  });
  try {
    await waitUntil(() => child.pid !== undefined && hasLiveProcessUnder(occupied.worktree) === true);
    for (let pass = 0; pass < 5; pass++)
      await removeFinishedWorktree(h.settings, h.store, fake(), { strayKept: (path) => kept.push(path) });
    expect(existsSync(integrated.worktree)).toBe(false);
    expect(existsSync(stopped.worktree)).toBe(false);
    expect(existsSync(unknown)).toBe(false);
    expect(existsSync(running.worktree)).toBe(true);
    expect(existsSync(occupied.worktree)).toBe(true);
    expect(kept).toContain(occupied.worktree);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    h.dispose();
  }
}, 30_000);

test('unknown root cleanup advances in bounded filesystem pages and resumes its cursor after store restart', async () => {
  const directory = temporaryDirectory();
  const mainCheckout = join(directory.path, 'main');
  const stateDirectory = join(directory.path, 'state');
  const worktreeRoot = join(directory.path, 'worktrees');
  const procRoot = join(directory.path, 'proc');
  mkdirSync(join(mainCheckout, '.temp/worktrees'), { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(join(procRoot, '1'), { recursive: true });
  mkdirSync(join(procRoot, 'sys'), { recursive: true });
  const paths = Array.from({ length: 100 }, (_, index) => join(worktreeRoot, `unknown-${String(index).padStart(3, '0')}`));
  for (const path of paths) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'payload'), 'unregistered owned remnant');
  }
  const settings = { stateDirectory, mainCheckout, worktreeRoot } as import('./types.ts').Settings;
  const databasePath = join(stateDirectory, 'goal.sqlite');
  let store = new WorkerStore(openDb(databasePath));
  const initialRuntime: LifetimeRuntime = {
    pressure: () => null,
    sleep: async () => {},
    command: () => {},
    procRoot,
    observe: () => {},
  };
  try {
    const initial: Record<string, number> = {};
    await removeFinishedWorktree(settings, store, {
      ...initialRuntime,
      observe: (unit) => {
        initial[unit] = (initial[unit] ?? 0) + 1;
      },
    });
    expect(initial['worktree-root-entry']).toBe(WORKTREE_SCAN_ENTRY_PAGE_SIZE);
    expect(paths.every(existsSync)).toBe(true);

    store.db.close();
    store = new WorkerStore(openDb(databasePath));
    let complete = false;
    for (let pass = 0; pass < 30; pass++) {
      const units: Record<string, number> = {};
      await removeFinishedWorktree(settings, store, {
        ...initialRuntime,
        observe: (unit) => {
          units[unit] = (units[unit] ?? 0) + 1;
        },
      });
      expect(units['worktree-root-entry'] ?? 0).toBeLessThanOrEqual(WORKTREE_SCAN_ENTRY_PAGE_SIZE);
      expect(units['worktree-tree-expansion'] ?? 0).toBeLessThanOrEqual(16);
      complete = paths.every((path) => !existsSync(path)) && !store.hasPendingStrayWorktrees() && store.worktreeScanComplete();
      if (complete) break;
    }
    expect(complete).toBe(true);
  } finally {
    store.db.close();
    directory.close();
  }
}, 30_000);

test('one failing task in a background pass is recorded once with its task id and does not fail the rest', async () => {
  const h = harness();
  const broken = h.tasks.dispatch(h.briefFile);
  const independent = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: broken.id, attempt: 0 }, (row) => {
    row.state = 'integrated';
  });
  h.store.updateTask({ taskId: independent.id, attempt: 0 }, (row) => {
    row.state = 'merged';
  });
  const real = fake();
  const io = fake({
    command: (command, args, cwd) => {
      const actual = args.slice(args.indexOf('git') + 1);
      if (actual[0] === 'worktree' && actual[1] === 'remove' && actual.at(-1) === broken.worktree)
        throw new Error(`fatal: disk I/O error on ${broken.worktree}`);
      real.command(command, args, cwd);
    },
  });
  const inbox: ManagerEvent[] = [];
  const job = new WorkerJob(
    h.tasks,
    { enqueue() {} },
    { deliver: (event) => inbox.push(event) },
    undefined,
    undefined,
    undefined,
    io,
  );
  try {
    await job.recoverOrphans();
    await job.drain();
    expect(existsSync(broken.worktree)).toBe(true);
    expect(existsSync(independent.worktree)).toBe(false);
    const reports = inbox.filter((event) => event.taskId === broken.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.summary).toContain(broken.id);
    expect(reports[0]!.summary).toContain('disk I/O error');
    await job.recoverOrphans();
    await job.drain();
    expect(inbox.filter((event) => event.taskId === broken.id)).toHaveLength(1);
  } finally {
    h.dispose();
  }
}, 30_000);

test('status reports stray directory count and bytes reclaimed in the last hour', async () => {
  const h = harness();
  const task = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: task.id, attempt: 0 }, (row) => {
    row.state = 'cancelled';
  });
  dropGitEntry(task.worktree, h.root);
  writeFileSync(join(task.worktree, 'payload.bin'), 'reclaim-me');
  const before = strayWorktreeStatus(h.settings);
  try {
    expect(before.strayDirectories).toBeGreaterThanOrEqual(1);
    expect(before.strayBytesReclaimedLastHour).toBe(0);
    await removeFinishedWorktree(h.settings, h.store, fake());
    const after = strayWorktreeStatus(h.settings);
    expect(after.strayDirectories).toBe(0);
    expect(after.strayBytesReclaimedLastHour).toBeGreaterThan(0);
    const printed: string[] = [];
    await runWorkerCommand('status', [], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print: (value) => printed.push(value),
    });
    const status = JSON.parse(printed[0]!) as {
      strayDirectories: number;
      strayBytesReclaimedLastHour: number;
    };
    expect(status.strayDirectories).toBe(0);
    expect(status.strayBytesReclaimedLastHour).toBe(after.strayBytesReclaimedLastHour);
  } finally {
    h.dispose();
  }
}, 30_000);
