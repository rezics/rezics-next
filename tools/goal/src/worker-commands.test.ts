import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './cli.ts';
import { loadSettings, type Runtime } from './config.ts';
import { openDb } from './db.ts';
import { prepareOwnerDecisionPrompt } from './owner-decisions.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks } from './tasks.ts';
import { brief, temporaryDirectory } from './test-support.ts';
import type { Attempt, Settings, Task } from './types.ts';
import { runWorkerCommand } from './worker-commands.ts';

test('diagnostics are read-only, tolerate unknown dependencies and use controller readiness', async () => {
  const temporary = temporaryDirectory();
  const previousLog = console.log;
  const previousManager = process.env.GOAL_MANAGER;
  const output: string[] = [];
  let mutations = 0;
  const mutate = () => {
    mutations++;
  };
  const task = (id: string, state: Task['state'], after: unknown = []) =>
    ({ id, brief: { after }, state, currentAttempt: 1 }) as unknown as Task;
  const expected = [
    ['missing', 'unknown', false],
    ['malformed', 'unknown', false],
    ['invalid-state', 'unknown', false],
    ['same-target', 'integrated', true],
    ['cross-visible', 'integrated', true],
    ['cross-waiting', 'integrated', false],
    ['merged', 'merged', true],
    ['running', 'running', false],
    ['cross-unrecorded', 'integrated', true],
  ];
  const held = task(
    'held',
    'held',
    expected.map(([id]) => id),
  );
  const all = [held, task('healthy', 'ready'), task('bad-after', 'held', 'invalid'), task('bad-id', 'held', [null])];
  const db = {
    query: (sql: string) => ({
      all: () => [],
      get: () => (sql.includes('manager_sessions') ? { id: 'operator' } : null),
      run: mutate,
    }),
    close() {},
  } as unknown as Runtime['db'];
  const store = {
    db,
    tasks: () => all,
    task: () => held,
    attempt: () => ({}),
    dependency(id: string) {
      if (id === 'missing') return undefined;
      if (id === 'malformed') throw new Error('malformed dependency');
      if (id === 'invalid-state') return { state: 'invalid' };
      if (id === 'merged' || id === 'running') return { state: id };
      return {
        state: 'integrated',
        target: id.startsWith('cross-') ? 'stabilize' : undefined,
        task_commit: id === 'cross-visible' ? 'refs/heads/dev' : id === 'cross-unrecorded' ? undefined : '0'.repeat(40),
      };
    },
    retryIntent: () => ({ status: 'pending' }),
    attempts: () => [],
    records: () => [],
  } as unknown as WorkerStore;
  const settings = {
    stateDirectory: temporary.path,
    mainCheckout: process.cwd(),
    integrationBranch: 'dev',
  } as Settings;
  const tasks = Object.assign(Object.create(WorkerTasks.prototype), { settings, store }) as WorkerTasks;
  const runtime = {
    db,
    settings,
    store,
    tasks,
    job: { drain: mutate, start: mutate },
    recoverOrphans: mutate,
  } as unknown as Runtime;

  process.env.GOAL_MANAGER = 'operator';
  console.log = (...values: unknown[]) => output.push(values.join(' '));
  try {
    for (const args of [['status'], ['status', 'held'], ['attempts'], ['attempts', '--json'], ['report']])
      expect(await run(args, () => runtime)).toBe(0);
  } finally {
    console.log = previousLog;
    if (previousManager === undefined) delete process.env.GOAL_MANAGER;
    else process.env.GOAL_MANAGER = previousManager;
    temporary.close();
  }

  const status = JSON.parse(output[0]!);
  const heldStatus = status.tasks[0];
  expect(
    heldStatus.dependencies.map(({ id, state, ready }: { id: string; state: string; ready: boolean }) => [
      id,
      state,
      ready,
    ]),
  ).toEqual(expected);
  expect(heldStatus.waitingFor).toEqual(expected.filter(([, , ready]) => !ready).map(([id]) => id));
  expect(heldStatus.pendingRetry).toEqual({ reason: 'dependencies', waitingFor: heldStatus.waitingFor });
  expect(JSON.parse(output[1]!)).toMatchObject(heldStatus);
  expect(status.tasks.map(({ id }: Task) => id)).toEqual(all.map(({ id }) => id));
  for (const malformed of status.tasks.slice(2))
    expect(malformed.dependencies).toMatchObject([{ state: 'unknown', ready: false }]);
  expect(mutations).toBe(0);
});

test('attempts selects a bounded task page and keeps the complete JSON export available', async () => {
  const root = join(process.cwd(), '.temp', `worker-command-attempts-${crypto.randomUUID()}`);
  const db = openDb(':memory:');
  mkdirSync(root, { recursive: true });
  try {
    const store = new WorkerStore(db);
    const insertTask = db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
    insertTask.run('target', 1, 2, JSON.stringify({ id: 'target', state: 'running' }));
    insertTask.run('other', 2, 1, JSON.stringify({ id: 'other', state: 'running' }));
    const insertAttempt = db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)');
    for (const [taskId, attempt] of [
      ['target', 1],
      ['target', 2],
      ['other', 1],
    ] as const)
      insertAttempt.run(
        taskId,
        attempt,
        JSON.stringify({
          taskId,
          attempt,
          state: 'running',
          profile: { model: 'model', effort: 'high' },
          pool: 'default',
        }),
      );
    const insertRecord = db.query('INSERT INTO worker_records(task_id, attempt, body) VALUES (?, ?, ?)');
    const records = [
      { taskId: 'target', attempt: 1, pool: 'default', outcome: 'passed', legacyField: 'kept' },
      { taskId: 'target', attempt: 2, pool: 'default', outcome: 'stopped' },
      { taskId: 'other', attempt: 1, pool: 'default', outcome: 'passed' },
    ];
    for (const record of records) insertRecord.run(record.taskId, record.attempt, JSON.stringify(record));

    const settings = { stateDirectory: root } as unknown as Settings;
    const tasks = { settings, store } as unknown as WorkerTasks;
    const invoke = async (argv: string[]) => {
      const output: string[] = [];
      const code = await runWorkerCommand('attempts', argv, {
        settings,
        tasks,
        store,
        env: {},
        print: (value) => output.push(value),
      });
      expect(code).toBe(0);
      return output[0];
    };

    expect(JSON.parse((await invoke(['--task', 'target', '--json', '--limit', '1']))!)).toEqual({
      records: [records[0]],
      hasMore: true,
      nextAfter: 1,
    });
    expect(await invoke(['--task', 'target', '--limit', '1'])).toContain(
      'More attempts remain; continue after attempt 1.',
    );
    const completeExport = [records[2], records[0], records[1]];
    expect(JSON.parse((await invoke(['--all', '--json']))!)).toEqual(completeExport);
    expect(JSON.parse((await invoke(['--json']))!)).toEqual(completeExport);
    expect(JSON.parse((await invoke(['--task', 'target', '--json', '--after', '2']))!)).toEqual({
      records: [],
      hasMore: false,
    });
    for (const argv of [
      ['--limit', '1'],
      ['--task', 'target', '--limit', '101'],
      ['--task', 'target', '--after', '-1'],
      ['--all', '--task', 'target', '--json'],
    ])
      await expect(invoke(argv)).rejects.toThrow('usage: attempts');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the event command authenticates the current owner and reserves decision and delivery records', async () => {
  const directory = temporaryDirectory();
  const db = openDb(join(directory.path, 'goal.sqlite'));
  const store = new WorkerStore(db);
  const settings = loadSettings({ cwd: directory.path, env: { GOAL_MAIN_CHECKOUT: directory.path } });
  try {
    const task = store.createTask({ ...brief(), manager: 'accounts' }, {
      briefPath: 'brief.md', worktree: directory.path, branch: 'worker/task-a', base: 'base',
    }, 'implementation', 'task-a');
    db.query("UPDATE worker_tasks SET current_attempt=1, body=json_set(body, '$.currentAttempt', 1) WHERE id=?").run(task.id);
    const attempt = { taskId: task.id, attempt: 1, state: 'waiting', session: 'worker-session', checks: ['check-identity'] } as Attempt;
    db.query('INSERT INTO worker_attempts VALUES (?, ?, ?)').run(task.id, 1, JSON.stringify(attempt));
    db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    for (const id of ['accounts', 'foreign']) db.query('INSERT INTO manager_sessions VALUES (?, ?)').run(id,
      JSON.stringify({ status: 'running', threadId: `${id}-session` }));
    const body = { decisionId: 'rule', summary: 'Apply the owner rule.' };
    const submit = (env: NodeJS.ProcessEnv, input: unknown = body, kind = 'owner-contract-decision', n = '1') =>
      runWorkerCommand('event', [task.id, n, kind, JSON.stringify(input)], { settings, store, env });
    const owner = { CODEX_THREAD_ID: 'accounts-session' };
    for (const env of [{}, { GOAL_MANAGER: 'accounts' }, { CODEX_THREAD_ID: 'foreign-session' },
      { CODEX_THREAD_ID: 'unknown-session', GOAL_MANAGER: 'accounts' },
      { CODEX_THREAD_ID: 'accounts-session', GOAL_MANAGER: 'foreign' }]) {
      await expect(submit(env)).rejects.toThrow('authenticated owning manager');
    }
    for (const forged of [{ ...body, senderSessionId: 'accounts-session' }, { ...body, managerId: 'accounts' },
      { ...body, attempt: 2 }, { ...body, decidedAt: '2099-01-01' }]) {
      await expect(submit(owner, forged)).rejects.toThrow('owner decision requires');
    }
    await expect(submit(owner, body, 'owner-contract-decision', '2')).rejects.toThrow();
    for (const kind of ['owner-contract-decision-accepted', 'owner-contract-decision-delivery'])
      await expect(submit(owner, { decisionId: 'accounts:rule', summaryDelivered: true }, kind))
        .rejects.toThrow('controller-owned');
    expect(store.events(task.id)).toHaveLength(0);

    await submit(owner);
    await submit(owner, { ...body, summary: 'A replay cannot replace the first decision.' });
    const persisted = new WorkerStore(db);
    const prepared = prepareOwnerDecisionPrompt(persisted, persisted.task(task.id), attempt, 'Continue.');
    expect(prepared.prompt).toContain(body.summary);
    expect(prepared.prompt).not.toContain('A replay');
    expect(JSON.parse(persisted.ownerDecisionEvents(attempt)[0]!.body)).toMatchObject({
      managerId: 'accounts', senderSessionId: 'accounts-session', taskId: task.id, attempt: 1,
    });
    expect(persisted.attempts(task.id)).toEqual([attempt]);
    expect(persisted.events(task.id).map((event) => event.kind)).toEqual([
      'owner-contract-decision-accepted', 'owner-contract-decision-accepted',
    ]);

    let sweeps = 0;
    // Exercise the CLI wrapper too: recording an event cannot launch work through orphan recovery.
    const code = await run(['event', task.id, '1', 'note', '{}'], () => ({
      settings, db, store: { db, assertCurrent() {}, event: store.event.bind(store) },
      tasks: { settings, store }, job: { async drain() {} },
      recoverOrphans: async () => { sweeps++; },
    }) as never);
    expect(code).toBe(0);
    expect(sweeps).toBe(0);
  } finally {
    db.close();
    directory.close();
  }
});
