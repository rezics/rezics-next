import { expect, test } from 'bun:test';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory, repository } from './test-support.ts';
import { createHourlyReportScheduler, singleFlight } from './integration-cli.ts';

const cli = join(import.meta.dir, 'fixtures/cli-runtime.ts');
const runtime = join(import.meta.dir, 'fixtures/cli-runtime.ts');

// Unix socket paths must fit sockaddr_un; use a short relative path under the repository's .temp.
function shortDirectory(absolute: string): string {
  return relative(process.cwd(), absolute);
}

test('goal inbox wait blocks in a separate process and exits promptly on another process delivery', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const env = { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path };
  const child = Bun.spawn([process.execPath, cli, 'inbox', 'wait', 'manager'], { env, stdout: 'pipe', stderr: 'pipe' });
  try {
    let exited = false;
    const exit = child.exited.then((code) => {
      exited = true;
      return code;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(exited).toBe(false);
    const before = Date.now();
    inbox.deliver({ managerId: 'manager', kind: 'instruction', summary: 'Choose a direction' });
    expect(await exit).toBe(0);
    expect(Date.now() - before).toBeLessThan(1000);
    expect(JSON.parse(await new Response(child.stdout).text())[0].event.summary).toBe('Choose a direction');
    const ack = Bun.spawn([process.execPath, cli, 'inbox', 'ack', 'manager'], { env, stdout: 'pipe', stderr: 'pipe' });
    expect(await ack.exited).toBe(0);
    expect(inbox.read('manager')).toHaveLength(0);
  } finally {
    child.kill();
    db.close();
    t.close();
  }
});

test('registered CLI commands enqueue, train and start and stop a manager through a durable host', async () => {
  const repo = repository();
  const stateAbsolute = join(repo.path, 'state');
  mkdirSync(stateAbsolute);
  const state = shortDirectory(stateAbsolute);
  const env = { ...process.env, FAKE_GOAL_STATE: state, FAKE_GOAL_MAIN: repo.main };
  const host = spawn(process.execPath, [cli, '_manager-host'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let hostError = '';
  host.stderr.on('data', (chunk) => {
    hostError += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()));
  const ready = new Promise<void>((resolveReady, reject) => {
    createInterface({ input: host.stdout }).once('line', (line) =>
      line === 'ready' ? resolveReady() : reject(new Error(line)),
    );
    host.once('exit', () => reject(new Error(hostError || 'Host exited before ready')));
  });
  const command = async (...argv: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...argv], { env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe('');
    return { code, stdout };
  };
  try {
    await ready;
    repo.branch('alpha', 'a');
    repo.branch('beta', 'b');
    expect((await command('land', 'alpha')).code).toBe(0);
    expect((await command('land', 'beta')).code).toBe(0);
    expect((await command('train')).code).toBe(0);
    const start = await command('manager', 'start', 'manager', '--engine', 'codex', '--budget', '20000');
    expect(start.code).toBe(0);
    expect(JSON.parse(start.stdout).threadId).toBe('thread-1');
    expect((await command('manager', 'stop', 'manager')).code).toBe(0);
  } finally {
    host.kill('SIGTERM');
    await exited;
    repo.close();
  }
}, 60_000);

test('manager start creates its host and returns while the host stays alive', async () => {
  const t = temporaryDirectory();
  const state = shortDirectory(t.path);
  const env = { ...process.env, FAKE_GOAL_STATE: state, FAKE_GOAL_MAIN: t.path };
  const child = Bun.spawn(
    [process.execPath, cli, 'manager', 'start', 'manager', '--engine', 'codex', '--budget', '20000'],
    { env, stdout: 'pipe', stderr: 'pipe' },
  );
  let hostPid: number | undefined;
  try {
    const code = await child.exited;
    const error = await new Response(child.stderr).text();
    expect(error).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text()).status).toBe('running');
    const { readdirSync, readFileSync, watch } = await import('node:fs');
    const leasePath = join(t.path, 'manager.sock.lease');
    hostPid = JSON.parse(readFileSync(join(leasePath, readdirSync(leasePath)[0]!), 'utf8')).pid;
    process.kill(hostPid!, 0);
    // Observe lease removal instead of polling for daemon shutdown.
    const released = new Promise<void>((resolveReleased) => {
      const watcher = watch(t.path, (_, name) => {
        if (name === 'manager.sock.lease') {
          watcher.close();
          resolveReleased();
        }
      });
    });
    process.kill(hostPid!, 'SIGTERM');
    await released;
    hostPid = undefined;
  } finally {
    if (hostPid) process.kill(hostPid, 'SIGTERM');
    child.kill();
    t.close();
  }
}, 60_000);

test('authenticated managers read cross-recipient filtered pages and threads without changing recipient state', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  new WorkerStore(db);
  db.run('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.query('INSERT INTO manager_sessions(id, state) VALUES (?, ?)').run(
    'reader',
    JSON.stringify({
      id: 'reader',
      kind: 'managed',
      status: 'running',
      threadId: 'reader-thread',
      goal: 'reader-goal',
    }),
  );
  inbox.deliver({
    managerId: 'recipient-a',
    from: 'manager-a',
    kind: 'question',
    summary: 'Which signed ID?',
    goalId: 'goal-a',
    taskId: 'task-a',
  });
  db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
    'valid-worker-task',
    1,
    1,
    JSON.stringify({
      id: 'valid-worker-task',
      currentAttempt: 1,
      state: 'running',
      brief: { goal: 'worker-goal', manager: 'worker-manager' },
    }),
  );
  db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
    'valid-worker-task',
    1,
    JSON.stringify({ taskId: 'valid-worker-task', attempt: 1, state: 'running' }),
  );
  const rootId = (db.query("SELECT id FROM manager_inbox WHERE summary = 'Which signed ID?'").get() as { id: number })
    .id;
  inbox.deliver({
    managerId: 'manager-a',
    from: 'recipient-a',
    kind: 'info',
    summary: 'Use v2 signed IDs',
    goalId: 'goal-a',
    taskId: 'task-a',
    replyToId: rootId,
  });
  inbox.deliver({
    managerId: 'recipient-a',
    from: 'manager-a',
    kind: 'info',
    summary: 'Second matching signed detail',
    goalId: 'goal-a',
    taskId: 'task-a',
  });
  db.query('UPDATE manager_inbox SET read_at = 31, acknowledged_at = NULL, notified = 1 WHERE manager = ?').run(
    'recipient-a',
  );
  db.query("UPDATE manager_inbox SET read_at = 32, acknowledged_at = 33 WHERE summary = 'Use v2 signed IDs'").run();
  const before = db
    .query('SELECT id, manager, notified, read_at, acknowledged_at FROM manager_inbox ORDER BY id')
    .all();
  const env = {
    ...process.env,
    FAKE_GOAL_STATE: t.path,
    FAKE_GOAL_MAIN: t.path,
    GOAL_MANAGER: 'reader',
    CODEX_THREAD_ID: 'reader-thread',
    CLAUDE_CODE_SESSION_ID: undefined,
  };
  const invoke = async (environment: NodeJS.ProcessEnv, ...argv: string[]) => {
    const child = Bun.spawn([process.execPath, runtime, ...argv], { env: environment, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
  try {
    const log = await invoke(
      env,
      'inbox',
      'log',
      '--from',
      'manager-a',
      '--to',
      'recipient-a',
      '--goal',
      'goal-a',
      '--task',
      'task-a',
      '--since',
      String(Date.now() - 60_000),
      '--grep',
      'SIGNED',
      '--limit',
      '1',
      '--json',
    );
    expect(log.code).toBe(0);
    expect(log.stderr).toBe('');
    const page = JSON.parse(log.stdout) as {
      entries: { summary: string }[];
      hasMore: boolean;
      nextCursor: number | null;
    };
    expect(page.entries.map((entry) => entry.summary)).toEqual(['Second matching signed detail']);
    expect(page.hasMore).toBe(true);
    const next = await invoke(
      env,
      'inbox',
      'log',
      '--from',
      'manager-a',
      '--to',
      'recipient-a',
      '--goal',
      'goal-a',
      '--task',
      'task-a',
      '--since',
      String(Date.now() - 60_000),
      '--grep',
      'SIGNED',
      '--limit',
      '1',
      '--cursor',
      String(page.nextCursor),
      '--json',
    );
    expect(JSON.parse(next.stdout).entries.map((entry: { summary: string }) => entry.summary)).toEqual([
      'Which signed ID?',
    ]);

    const byId = await invoke(env, 'inbox', 'thread', String(rootId), '--json');
    expect(byId.stderr).toBe('');
    const thread = JSON.parse(byId.stdout) as { entries: { summary: string; from: string | null }[] };
    expect(thread.entries.map((entry) => entry.summary)).toEqual(['Which signed ID?', 'Use v2 signed IDs']);
    expect(thread.entries.map((entry) => entry.from)).toEqual(['manager-a', 'recipient-a']);
    const byTask = await invoke(env, 'inbox', 'thread', 'task-a', '--json');
    expect(byTask.stderr).toBe('');
    expect(JSON.parse(byTask.stdout).entries).toHaveLength(3);
    expect(
      db.query('SELECT id, manager, notified, read_at, acknowledged_at FROM manager_inbox ORDER BY id').all(),
    ).toEqual(before);

    const claimedByNameOnly = await invoke({ ...env, CODEX_THREAD_ID: undefined }, 'inbox', 'log', '--json');
    expect(claimedByNameOnly.code).not.toBe(0);
    const worker = await invoke(
      { ...env, GOAL_TASK_ID: 'valid-worker-task', GOAL_ATTEMPT: '1' },
      'inbox',
      'log',
      '--json',
    );
    expect(worker.code).not.toBe(0);
  } finally {
    db.close();
    t.close();
  }
});

test('a single-flight child starts again only after the previous one has exited', async () => {
  const starts: ReturnType<typeof spawn>[] = [];
  const start = singleFlight(() => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
    starts.push(child);
    return child;
  });
  const first = start();
  expect(first).toBeDefined();
  expect(start()).toBeUndefined();
  await new Promise((resolve) => first!.once('exit', resolve));
  expect(start()).toBeDefined();
  await new Promise((resolve) => starts[1]!.once('exit', resolve));
  expect(starts).toHaveLength(2);
});

test('host publishes once per completed UTC hour without waiting for the report sender', () => {
  let now = new Date('2026-10-31T02:30:00.000Z');
  const calls: string[] = [];
  const neverFinishes = new Promise<void>(() => {});
  const publish = createHourlyReportScheduler(
    async (bucket) => {
      calls.push(bucket);
      await neverFinishes;
    },
    () => now,
  );

  expect(publish()).toBeUndefined();
  expect(publish()).toBeUndefined();
  now = new Date('2026-10-31T03:01:00.000Z');
  expect(publish()).toBeUndefined();
  expect(calls).toEqual(['2026-10-31T01:00:00.000Z', '2026-10-31T02:00:00.000Z']);
});
