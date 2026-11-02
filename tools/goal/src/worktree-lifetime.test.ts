import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { harness } from './test-support.ts';
import { git } from './tasks.ts';
import {
  removeFinishedWorktree,
  IO_PRESSURE_LIMIT,
  IO_PRESSURE_WAIT_ATTEMPTS,
  type LifetimeRuntime,
} from './worktree-lifetime.ts';

function setup(
  state: 'integrated' | 'merged' | 'cancelled' | 'running' | 'landing' | 'ready' | 'held' | 'stopped' = 'integrated',
) {
  const h = harness();
  const task = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: task.id, attempt: 0 }, (row) => {
    row.state = state;
  });
  return { h, task: h.store.task(task.id) };
}
function fake(overrides: Partial<LifetimeRuntime> = {}): LifetimeRuntime {
  return {
    pressure: () => null,
    sleep: async () => {},
    command: (command, args, cwd) => {
      const gitIndex = args.indexOf('git');
      const actual = args.slice(gitIndex + 1);
      const result = Bun.spawnSync(['git', ...actual], { cwd, stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0 && !(actual[0] === 'worktree' && actual[1] === 'remove' && !existsSync(actual.at(-1)!)))
        throw new Error(new TextDecoder().decode(result.stderr));
      void command;
    },
    ...overrides,
  };
}

function failingRemoval(
  taskWorktree: string,
  blocker: string,
  count: { value: number },
  fail: () => boolean,
): LifetimeRuntime {
  const real = fake();
  return fake({
    command: (command, args, cwd) => {
      const gitIndex = args.indexOf('git');
      const actual = args.slice(gitIndex + 1);
      if (actual[0] === 'worktree' && actual[1] === 'remove' && actual.at(-1) === taskWorktree) {
        count.value++;
        if (fail()) throw new Error(`fatal: could not remove '${blocker}': Permission denied`);
      }
      real.command(command, args, cwd);
    },
  });
}

function deliverCleanupNotice(inbox: SqliteManagerInbox): Parameters<typeof removeFinishedWorktree>[3] {
  return (task, disposition) => {
    const owner = disposition.owner ? `${disposition.owner.uid}:${disposition.owner.gid}` : 'unknown';
    inbox.deliver({
      managerId: task.brief.manager,
      kind: 'environment',
      taskId: task.id,
      summary: `environment: finished worktree cleanup is blocked at ${disposition.path} (owner ${owner}).`,
    });
  };
}

test('a task worktree is removed after integration, merge or cancellation while its branch and commits stay', async () => {
  for (const state of ['integrated', 'merged', 'cancelled'] as const) {
    const { h, task } = setup(state);
    try {
      git(task.worktree, ['commit', '--allow-empty', '-m', 'retained task commit']);
      const head = git(task.worktree, ['rev-parse', 'HEAD']);
      await removeFinishedWorktree(h.settings, h.store, fake());
      expect(existsSync(task.worktree)).toBe(false);
      expect(git(h.root, ['rev-parse', task.branch])).toBe(head);
    } finally {
      h.dispose();
    }
  }
}, 30_000);

test('worktrees of running, landing, ready, held and stopped tasks are never removed', async () => {
  const { h, task } = setup('running');
  try {
    for (const state of ['running', 'landing', 'ready', 'held', 'stopped'] as const) {
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (row) => {
        row.state = state;
      });
      await removeFinishedWorktree(h.settings, h.store, fake());
      expect(existsSync(task.worktree)).toBe(true);
    }
  } finally {
    h.dispose();
  }
}, 30_000);

test('removal takes one worktree at a time and waits while disk pressure is above the limit', async () => {
  const { h, task } = setup('integrated');
  const second = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: second.id, attempt: 0 }, (row) => {
    row.state = 'cancelled';
  });
  const observed: number[] = [];
  let pressure = IO_PRESSURE_LIMIT + 1;
  try {
    const io = fake({
      pressure: () => pressure,
      sleep: async () => {
        observed.push(pressure);
        pressure = IO_PRESSURE_LIMIT;
      },
    });
    expect(await removeFinishedWorktree(h.settings, h.store, io)).toBe(task.id);
    expect(observed).toEqual([IO_PRESSURE_LIMIT + 1]);
    expect(existsSync(second.worktree)).toBe(true);
  } finally {
    h.dispose();
  }
});

test('finished-worktree cleanup defers within a finite pass under sustained I/O pressure and later resumes safely', async () => {
  const { h, task } = setup('integrated');
  let waits = 0;
  let commands = 0;
  const pressured = fake({
    pressure: () => IO_PRESSURE_LIMIT + 1,
    sleep: async () => {
      waits++;
    },
    command: () => {
      commands++;
    },
  });
  try {
    expect(await removeFinishedWorktree(h.settings, h.store, pressured)).toBeNull();
    expect(waits).toBe(IO_PRESSURE_WAIT_ATTEMPTS);
    expect(commands).toBe(0);
    expect(existsSync(task.worktree)).toBe(true);
    expect(h.store.worktreeCleanup(task.id)).toBeUndefined();

    expect(await removeFinishedWorktree(h.settings, h.store, fake())).toBe(task.id);
    expect(existsSync(task.worktree)).toBe(false);
  } finally {
    h.dispose();
  }
});

test('a retry recreates a removed task worktree from its task branch and installs dependencies before launch', async () => {
  const { h, task } = setup('stopped');
  writeFileSync(join(task.worktree, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  const install = Bun.spawnSync(['bun', 'install'], { cwd: task.worktree, stdout: 'pipe', stderr: 'pipe' });
  if (install.exitCode !== 0) throw new Error(new TextDecoder().decode(install.stderr));
  git(task.worktree, ['add', 'package.json']);
  git(task.worktree, ['commit', '-m', 'Add dependency manifest']);
  const original = git(task.worktree, ['rev-parse', 'HEAD']);
  git(h.root, ['worktree', 'remove', '--force', task.worktree]);
  try {
    await h.tasks.retry(task.id);
    expect(existsSync(task.worktree)).toBe(true);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(original);
    expect(existsSync(join(task.worktree, 'node_modules'))).toBe(true);
  } finally {
    h.dispose();
  }
});

test('a finished task with a missing directory prunes Git worktree metadata without an error or retry', async () => {
  const { h, task } = setup('merged');
  try {
    rmSync(task.worktree, { recursive: true, force: true });
    await expect(removeFinishedWorktree(h.settings, h.store, fake())).resolves.toBeNull();
    const listed = git(h.root, ['worktree', 'list', '--porcelain']);
    expect(listed).not.toContain(task.worktree);
  } finally {
    h.dispose();
  }
});

test('a finished worktree EACCES records its actual owner once across sweeps and store restart', async () => {
  const { h, task } = setup('integrated');
  const blocker = join(task.worktree, 'container-owned-output');
  writeFileSync(blocker, 'owned by the filesystem fixture');
  chmodSync(task.worktree, 0o555);
  const count = { value: 0 };
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  // Root can bypass this DAC boundary, so only that runner injects the same Git EACCES result.
  const io = failingRemoval(task.worktree, blocker, count, () => runningAsRoot);
  const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
  let originalDbClosed = false;
  try {
    await removeFinishedWorktree(h.settings, h.store, io, deliverCleanupNotice(inbox));
    const disposition = h.store.worktreeCleanup(task.id)!;
    const owner = lstatSync(disposition.path);
    expect(disposition.path === task.worktree || disposition.path.startsWith(`${task.worktree}/`)).toBe(true);
    expect(disposition.owner).toEqual({ uid: owner.uid, gid: owner.gid });
    if (runningAsRoot) expect(disposition.owner?.uid).toBe(0);
    expect(disposition.detail).toContain('Permission denied');
    expect(inbox.pending(task.brief.manager)).toHaveLength(1);
    expect(count.value).toBe(1);

    await removeFinishedWorktree(h.settings, h.store, io, deliverCleanupNotice(inbox));
    expect(count.value).toBe(1);
    expect(inbox.pending(task.brief.manager)).toHaveLength(1);

    const databasePath = join(h.settings.stateDirectory, 'goal.sqlite');
    h.store.db.close();
    originalDbClosed = true;
    const restarted = new WorkerStore(openDb(databasePath));
    try {
      const restartedInbox = new SqliteManagerInbox(restarted.db, h.settings.integration.inboxDirectory);
      await removeFinishedWorktree(h.settings, restarted, io, deliverCleanupNotice(restartedInbox));
      expect(restarted.worktreeCleanup(task.id)).toEqual(disposition);
      expect(count.value).toBe(1);
      expect(restartedInbox.pending(task.brief.manager)).toHaveLength(1);
    } finally {
      if (existsSync(task.worktree)) chmodSync(task.worktree, 0o755);
      restarted.db.close();
      rmSync(h.root, { recursive: true, force: true });
    }
  } catch (error) {
    if (existsSync(task.worktree)) chmodSync(task.worktree, 0o755);
    if (originalDbClosed) rmSync(h.root, { recursive: true, force: true });
    else h.dispose();
    throw error;
  }
});

test('a blocked cleanup does not stop controller recovery from removing an independent finished worktree', async () => {
  const { h, task: blocked } = setup('integrated');
  const independent = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: independent.id, attempt: 0 }, (row) => {
    row.state = 'merged';
  });
  const blocker = join(blocked.worktree, 'container-owned-output');
  writeFileSync(blocker, 'permission failure fixture');
  const count = { value: 0 };
  const io = failingRemoval(blocked.worktree, blocker, count, () => true);
  const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
  const job = new WorkerJob(h.tasks, { enqueue() {} }, inbox, undefined, undefined, undefined, io);
  try {
    await job.recoverOrphans();
    await job.drain();
    expect(existsSync(blocked.worktree)).toBe(true);
    expect(h.store.worktreeCleanup(blocked.id)?.path).toBe(blocker);
    expect(existsSync(independent.worktree)).toBe(false);
    expect(count.value).toBe(1);
    expect(inbox.pending(blocked.brief.manager)).toHaveLength(1);
    expect(git(h.root, ['rev-parse', independent.branch])).toBeTruthy();
  } finally {
    h.dispose();
  }
});

test('a changed offending path generation permits one bounded retry after operator remediation', async () => {
  const { h, task } = setup('cancelled');
  const blocker = join(task.worktree, 'container-owned-output');
  writeFileSync(blocker, 'permission failure fixture');
  chmodSync(task.worktree, 0o555);
  const count = { value: 0 };
  let denied = typeof process.getuid === 'function' && process.getuid() === 0;
  const io = failingRemoval(task.worktree, task.worktree, count, () => denied);
  try {
    await removeFinishedWorktree(h.settings, h.store, io);
    const first = h.store.worktreeCleanup(task.id)!;
    expect(first.generation).toHaveLength(64);
    await removeFinishedWorktree(h.settings, h.store, io);
    expect(count.value).toBe(1);

    const oldMode = lstatSync(task.worktree).mode;
    chmodSync(task.worktree, 0o755);
    expect(lstatSync(task.worktree).mode).not.toBe(oldMode);
    denied = false;
    expect(await removeFinishedWorktree(h.settings, h.store, io)).toBe(task.id);
    expect(count.value).toBe(2);
    expect(existsSync(task.worktree)).toBe(false);
    expect(h.store.worktreeCleanup(task.id)).toBeUndefined();
  } finally {
    if (existsSync(task.worktree)) chmodSync(task.worktree, 0o755);
    h.dispose();
  }
});

test('cleanup leaves active worktrees, shared dependency stores, external symlink targets and unrelated paths intact', async () => {
  const { h, task } = setup('integrated');
  const active = h.tasks.dispatch(h.briefFile);
  h.store.updateTask({ taskId: active.id, attempt: 0 }, (row) => {
    row.state = 'running';
  });
  const unrelated = join(h.settings.worktreeRoot, 'unrelated-directory');
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, 'sentinel'), 'leave me');

  const storeRoot = join(dirname(task.worktree), '..', 'dependency-stores');
  const storeNames = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), 'f'.repeat(64)];
  const stores = storeNames.map((name) => join(storeRoot, name));
  for (const [index, store] of stores.entries()) {
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'sentinel'), `immutable store ${index}`);
    const old = new Date(Date.now() - (48 + index) * 60 * 60 * 1000);
    utimesSync(store, old, old);
  }
  const dependencyLink = join(task.worktree, 'node_modules', '.bun');
  expect(lstatSync(dependencyLink).isSymbolicLink()).toBe(true);
  const linkedStore = resolve(dirname(dependencyLink), readlinkSync(dependencyLink));
  const linkedStoreIdentity = lstatSync(linkedStore);
  const linkedStoreEntries = readdirSync(linkedStore).sort();
  const outside = join(h.root, 'outside-target');
  writeFileSync(outside, 'external data');
  symlinkSync(outside, join(task.worktree, 'external-link'));

  try {
    expect(await removeFinishedWorktree(h.settings, h.store, fake())).toBe(task.id);
    expect(existsSync(active.worktree)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('external data');
    const remainingStore = lstatSync(linkedStore);
    expect(remainingStore.dev).toBe(linkedStoreIdentity.dev);
    expect(remainingStore.ino).toBe(linkedStoreIdentity.ino);
    expect(readdirSync(linkedStore).sort()).toEqual(linkedStoreEntries);
    for (const store of stores) expect(existsSync(join(store, 'sentinel'))).toBe(true);
  } finally {
    h.dispose();
  }
});
