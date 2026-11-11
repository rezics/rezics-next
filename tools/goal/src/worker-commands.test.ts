import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './cli.ts';
import { loadSettings, type Runtime } from './config.ts';
import { openDb } from './db.ts';
import { prepareOwnerDecisionPrompt } from './owner-decisions.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks } from './tasks.ts';
import { brief, harness, temporaryDirectory } from './test-support.ts';
import type { Attempt, Settings, Task } from './types.ts';
import { runWorkerCommand } from './worker-commands.ts';

test('diagnostics are read-only, tolerate unknown dependencies and use controller readiness', async () => {
  const temporary = temporaryDirectory();
  const previousLog = console.log;
  const previousManager = process.env.GOAL_MANAGER;
  const output: string[] = [];
  let mutations = 0;
  const reads = { tasks: 0, task: 0, attempt: 0, retryIntent: 0, incidentHistory: 0 };
  const statusReads: (typeof reads)[] = [];
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
    query: (sql: string) => {
      if (sql === 'SELECT sequence, body FROM worker_events WHERE kind=? ORDER BY sequence') reads.incidentHistory++;
      return {
        all: () => [],
        get: () => (sql.includes('manager_sessions') ? { id: 'operator' } : null),
        run: mutate,
      };
    },
    close() {},
  } as unknown as Runtime['db'];
  const store = {
    db,
    tasks: () => {
      reads.tasks++;
      return all;
    },
    task: (id: string) => {
      reads.task++;
      if (id !== 'held') throw new Error(`unknown task: ${id}`);
      return held;
    },
    attempt: (ref: { taskId: string }) => {
      reads.attempt++;
      if (ref.taskId === 'missing-attempt') throw new Error('unknown attempt');
      return {};
    },
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
    retryIntent: () => {
      reads.retryIntent++;
      return { status: 'pending' };
    },
    events: () => [],
    attempts: () => [],
    records: () => [],
    runningAttemptsByPool: () => ({}),
    waitingAttemptsByPool: () => ({}),
  } as unknown as WorkerStore;
  const checkout = join(temporary.path, 'checkout');
  mkdirSync(checkout);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args[0]} failed`);
  };
  git('init', '-b', 'dev');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('commit', '--allow-empty', '-m', 'dev');
  const settings = {
    stateDirectory: temporary.path,
    mainCheckout: checkout,
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
    for (const args of [['status'], ['status', 'held'], ['attempts'], ['attempts', '--json'], ['report']]) {
      expect(await run(args, () => runtime)).toBe(0);
      if (args[0] === 'status') {
        statusReads.push({ ...reads });
        Object.assign(reads, { tasks: 0, task: 0, attempt: 0, retryIntent: 0, incidentHistory: 0 });
      }
    }
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
  expect(status.trains).toEqual([
    { lane: 'main', state: 'missing' },
    { lane: 'dev', state: 'missing' },
  ]);
  expect(status.reapedLastHour).toEqual({ processes: 0, containers: 0, volumes: 0, bytes: 0 });
  expect(status.strayDirectories).toBe(0);
  expect(status.strayBytesReclaimedLastHour).toBe(0);
  expect(status.taskCounts).toEqual({
    total: all.length,
    byGoal: { unknown: all.length },
    byState: { held: 3, ready: 1 },
  });
  expect(JSON.parse(output[1]!).trains).toEqual(status.trains);
  expect(status.tasks.map(({ id }: Task) => id)).toEqual(all.map(({ id }) => id));
  for (const malformed of status.tasks.slice(2))
    expect(malformed.dependencies).toMatchObject([{ state: 'unknown', ready: false }]);
  expect(statusReads).toEqual([
    { tasks: 1, task: 0, attempt: 4, retryIntent: 4, incidentHistory: 1 },
    { tasks: 0, task: 1, attempt: 1, retryIntent: 1, incidentHistory: 1 },
  ]);
  Object.assign(reads, { tasks: 0, task: 0, attempt: 0, retryIntent: 0, incidentHistory: 0 });
  await expect(
    runWorkerCommand('status', ['missing'], {
      settings,
      store: store as unknown as WorkerStore,
      tasks,
      print() {},
    }),
  ).rejects.toThrow('unknown task: missing');
  expect(reads).toEqual({ tasks: 0, task: 1, attempt: 0, retryIntent: 0, incidentHistory: 0 });
  all.push(task('missing-attempt', 'ready'));
  Object.assign(reads, { tasks: 0, task: 0, attempt: 0, retryIntent: 0, incidentHistory: 0 });
  await expect(
    runWorkerCommand('status', [], { settings, store: store as unknown as WorkerStore, tasks, print() {} }),
  ).rejects.toThrow('unknown attempt');
  expect(reads).toEqual({ tasks: 1, task: 0, attempt: 5, retryIntent: 4, incidentHistory: 0 });
  expect(mutations).toBe(0);
});

test('global status summarizes large history while retaining full single-task briefs and active waits', async () => {
  const h = harness();
  const largeBrief = `brief-marker:${'b'.repeat(1_500_000)}`;
  const largeHistory = `history-marker:${'h'.repeat(1_500_000)}`;
  const location = (id: string) => ({
    briefPath: join(h.root, `${id}.md`),
    worktree: h.root,
    branch: `worker/${id}`,
    base: 'fixture-base',
  });
  const makeAttempt = (taskId: string, attempt: number, state: Attempt['state'], result = ''): Attempt => ({
    taskId,
    attempt,
    state,
    profile: { cli: 'codex', model: 'fixture-model', effort: 'low', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: new Date().toISOString(),
    endedAt: state === 'exited' ? new Date().toISOString() : null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', taskId, `${attempt}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', taskId, String(attempt)),
    auxiliaryProcesses: [],
    session: state === 'waiting' ? 'fixture-session' : null,
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: state === 'exited' ? 0 : null,
    result,
    blocker: null,
    approaches: [],
  });
  const create = (id: string, goal: string, markdown: string, after: string[] = []) =>
    h.store.createTask(
      { ...brief(), goal, manager: 'owner', after, markdown },
      location(id),
      'implementation',
      id,
    );

  try {
    const archive = create('archive', 'history', largeBrief);
    h.store.nextAttempt({ taskId: archive.id, attempt: 0 }, (attempt) =>
      makeAttempt(archive.id, attempt, 'exited', largeHistory),
    );
    h.store.updateTask({ taskId: archive.id, attempt: 1 }, (task) => {
      task.state = 'integrated';
    });
    const merged = create('merged-history', 'history', largeBrief);
    h.store.updateTask({ taskId: merged.id, attempt: 0 }, (task) => {
      task.state = 'merged';
    });
    const cancelled = create('cancelled-history', 'history', largeBrief);
    h.store.updateTask({ taskId: cancelled.id, attempt: 0 }, (task) => {
      task.state = 'cancelled';
    });
    const dependency = create('live-dependency', 'live', 'dependency');
    h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (task) => {
      task.state = 'running';
    });
    const active = create('live-held', 'live', largeBrief, [dependency.id]);
    h.store.nextAttempt({ taskId: active.id, attempt: 0 }, (attempt) =>
      makeAttempt(active.id, attempt, 'exited'),
    );
    h.store.updateTask({ taskId: active.id, attempt: 1 }, (task) => {
      task.state = 'held';
    });
    h.store.saveRetryIntent({ taskId: active.id, attempt: 1 }, {});
    const terminating = create('live-termination', 'live', 'termination');
    h.store.nextAttempt({ taskId: terminating.id, attempt: 0 }, (attempt) =>
      makeAttempt(terminating.id, attempt, 'running'),
    );
    h.store.updateTask({ taskId: terminating.id, attempt: 1 }, (task) => {
      task.state = 'running';
    });
    h.store.updateAttempt({ taskId: terminating.id, attempt: 1 }, (attempt) => {
      attempt.terminationIntent = {
        operation: 'stop',
        requestedAt: new Date().toISOString(),
        state: 'requested',
        processIdentity: 'known',
        process: null,
        auxiliaryProcesses: [],
      };
    });
    const ready = create('live-ready', 'live', 'ready');
    const routing = JSON.parse(readFileSync(join(import.meta.dir, '../routing.json'), 'utf8')) as {
      [key: string]: unknown;
      experiments: unknown[];
    };
    routing.experiments = [];
    h.settings.routingFile = join(h.settings.stateDirectory, 'routing-status-test.json');
    writeFileSync(h.settings.routingFile, JSON.stringify(routing));
    const fixturePool = h.settings.pools![0]!;
    h.settings.pools = [{ ...fixturePool, policy: { ...fixturePool.policy, allowUnknown: false } }];
    h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    h.store.db
      .query('INSERT INTO manager_sessions(id, state) VALUES (?, ?)')
      .run(
        'mail-manager',
        JSON.stringify({
          kind: 'managed',
          goal: 'live',
          status: 'running',
          threadId: 'thread-mail',
          activeTurnId: null,
          waitingForInbox: true,
          turnDisposition: {
            threadId: 'thread-mail',
            turnId: 'turn-housekeeping',
            status: 'interrupted',
            intent: 'controller-park',
            at: 1,
          },
          goalState: { status: 'paused' },
        }),
      );

    const attemptRead = spyOn(h.store, 'attempt');
    const globalOutput: string[] = [];
    await runWorkerCommand('status', [], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      env: {},
      print: (value) => globalOutput.push(value),
    });

    expect(Buffer.byteLength(globalOutput[0]!)).toBeLessThan(16_384);
    expect(globalOutput[0]).not.toContain('brief-marker:');
    expect(globalOutput[0]).not.toContain('history-marker:');
    const status = JSON.parse(globalOutput[0]!);
    expect(status.taskCounts).toEqual({
      total: 7,
      byGoal: { history: 3, live: 4 },
      byState: { cancelled: 1, held: 1, integrated: 1, merged: 1, ready: 1, running: 2 },
    });
    expect(status.tasks.map((task: Task) => task.id)).toEqual([dependency.id, active.id, terminating.id, ready.id]);
    expect(status.tasks[1]).toMatchObject({
      id: active.id,
      sequence: active.sequence,
      brief: { goal: 'live', manager: 'owner' },
      state: 'held',
      currentAttempt: 1,
      dependencies: [{ id: dependency.id, state: 'running', ready: false }],
      waitingFor: [dependency.id],
      pendingRetry: { reason: 'dependencies', waitingFor: [dependency.id] },
    });
    expect(status.tasks[1].brief).not.toHaveProperty('markdown');
    expect(status.tasks[1].brief).not.toHaveProperty('paths');
    expect(status.tasks[2]).toMatchObject({
      id: terminating.id,
      state: 'running',
      currentAttempt: 1,
      terminationRequest: { operation: 'stop', state: 'requested', processIdentity: 'known' },
    });
    expect(status.pools).toContainEqual(expect.objectContaining({ name: 'fixture', waiting: 1 }));
    expect(status.managers).toContainEqual(
      expect.objectContaining({
        id: 'mail-manager',
        goals: ['live'],
        operation: 'waiting-for-inbox',
        threadId: 'thread-mail',
        activeTurnId: null,
        waitingForInbox: true,
        nativeGoalStatus: 'paused',
        turnDisposition: expect.objectContaining({ intent: 'controller-park', status: 'interrupted' }),
      }),
    );
    expect(attemptRead).toHaveBeenCalledTimes(2);

    attemptRead.mockClear();
    const singleOutput: string[] = [];
    await runWorkerCommand('status', [active.id], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      env: {},
      print: (value) => singleOutput.push(value),
    });
    const single = JSON.parse(singleOutput[0]!);
    expect(single).toMatchObject(h.store.task(active.id));
    expect(single.brief.markdown).toBe(largeBrief);
    expect(single.brief.paths).toEqual(brief().paths);
    expect(Buffer.byteLength(singleOutput[0]!)).toBeGreaterThan(1_500_000);
    expect(attemptRead).toHaveBeenCalledTimes(1);
  } finally {
    h.dispose();
  }
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
    const task = store.createTask(
      { ...brief(), manager: 'accounts' },
      {
        briefPath: 'brief.md',
        worktree: directory.path,
        branch: 'worker/task-a',
        base: 'base',
      },
      'implementation',
      'task-a',
    );
    db.query("UPDATE worker_tasks SET current_attempt=1, body=json_set(body, '$.currentAttempt', 1) WHERE id=?").run(
      task.id,
    );
    const attempt = {
      taskId: task.id,
      attempt: 1,
      state: 'waiting',
      session: 'worker-session',
      checks: ['check-identity'],
    } as Attempt;
    db.query('INSERT INTO worker_attempts VALUES (?, ?, ?)').run(task.id, 1, JSON.stringify(attempt));
    db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    for (const id of ['accounts', 'foreign'])
      db.query('INSERT INTO manager_sessions VALUES (?, ?)').run(
        id,
        JSON.stringify({ status: 'running', threadId: `${id}-session` }),
      );
    const body = { decisionId: 'rule', summary: 'Apply the owner rule.' };
    const submit = (env: NodeJS.ProcessEnv, input: unknown = body, kind = 'owner-contract-decision', n = '1') =>
      runWorkerCommand('event', [task.id, n, kind, JSON.stringify(input)], { settings, store, env });
    const owner = { CODEX_THREAD_ID: 'accounts-session' };
    for (const env of [
      {},
      { GOAL_MANAGER: 'accounts' },
      { CODEX_THREAD_ID: 'foreign-session' },
      { CODEX_THREAD_ID: 'unknown-session', GOAL_MANAGER: 'accounts' },
      { CODEX_THREAD_ID: 'accounts-session', GOAL_MANAGER: 'foreign' },
    ]) {
      await expect(submit(env)).rejects.toThrow('authenticated owning manager');
    }
    for (const forged of [
      { ...body, senderSessionId: 'accounts-session' },
      { ...body, managerId: 'accounts' },
      { ...body, attempt: 2 },
      { ...body, decidedAt: '2099-01-01' },
    ]) {
      await expect(submit(owner, forged)).rejects.toThrow('owner decision requires');
    }
    await expect(submit(owner, body, 'owner-contract-decision', '2')).rejects.toThrow();
    for (const kind of [
      'owner-contract-decision-accepted',
      'owner-contract-decision-delivery',
      'owner-contract-decisions-superseded',
    ])
      await expect(submit(owner, { decisionId: 'accounts:rule', summaryDelivered: true }, kind)).rejects.toThrow(
        'controller-owned',
      );
    expect(store.events(task.id)).toHaveLength(0);

    await submit(owner);
    await submit(owner, { ...body, summary: 'A replay cannot replace the first decision.' });
    const persisted = new WorkerStore(db);
    const prepared = prepareOwnerDecisionPrompt(persisted, persisted.task(task.id), attempt, 'Continue.');
    expect(prepared.prompt).toContain(body.summary);
    expect(prepared.prompt).not.toContain('A replay');
    expect(JSON.parse(persisted.ownerDecisionEvents(attempt)[0]!.body)).toMatchObject({
      managerId: 'accounts',
      senderSessionId: 'accounts-session',
      taskId: task.id,
      attempt: 1,
    });
    expect(persisted.attempts(task.id)).toEqual([attempt]);
    expect(persisted.events(task.id).map((event) => event.kind)).toEqual([
      'owner-contract-decision-accepted',
      'owner-contract-decision-accepted',
    ]);

    let sweeps = 0;
    // Exercise the CLI wrapper too: recording an event cannot launch work through orphan recovery.
    const code = await run(
      ['event', task.id, '1', 'note', '{}'],
      () =>
        ({
          settings,
          db,
          store: { db, assertCurrent() {}, event: store.event.bind(store) },
          tasks: { settings, store },
          job: { async drain() {} },
          recoverOrphans: async () => {
            sweeps++;
          },
        }) as never,
    );
    expect(code).toBe(0);
    expect(sweeps).toBe(0);
  } finally {
    db.close();
    directory.close();
  }
});
