import { expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { awaitHostCapacity, capacityAvailable, capacityWaiters } from './launch.ts';
import { harness, temporaryDirectory } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { parseWorkerCommandArguments } from './command-arguments.ts';
import { renderHourlyEfficiencyReport } from './efficiency-report.ts';
import { recordFlow, readFlow, readFlowTasks, flowReport } from './flow.ts';
import { report } from './report.ts';
import { makeRecord } from './records.ts';
import { defaultPolicy } from './policy.ts';

test('urgent flag and front matter require a live supermanager session or its revocable manager grant', async () => {
  const h = harness();
  try {
    const owner = 'repair-manager',
      parent = h.settings.integration.supermanager;
    h.store.db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    for (const id of [owner, parent])
      h.store.db
        .query('INSERT OR REPLACE INTO manager_sessions VALUES (?,?)')
        .run(id, JSON.stringify({ id, status: 'running', threadId: `${id}-session` }));
    const started: string[] = [],
      printed: string[] = [];
    const runtime = {
      settings: h.settings,
      db: h.store.db,
      store: h.store,
      tasks: h.tasks,
      drain: async () => {},
      job: {
        start: async (id: string) => {
          started.push(id);
        },
        drain: async () => {},
      },
    } as never;
    const call = (command: string, args: string[], id?: string) =>
      runWorkerCommand(command, args, {
        runtime,
        env: id ? { CODEX_THREAD_ID: `${id}-session`, GOAL_MANAGER: id } : { GOAL_MANAGER: parent },
        print: (text) => printed.push(text),
      });
    expect(parseWorkerCommandArguments('dispatch', ['--urgent', h.briefFile])).toMatchObject({ urgent: true });
    await expect(call('dispatch', ['--urgent', h.briefFile])).rejects.toThrow('authenticated manager');
    await expect(call('dispatch', ['--urgent', h.briefFile], owner)).rejects.toThrow('active urgent grant');
    await expect(call('urgent', ['grant', owner], owner)).rejects.toThrow('only configured supermanager');
    await call('dispatch', ['--urgent', h.briefFile], parent);
    const urgent = h.store.task(started[0]!);
    expect(urgent.brief.urgent).toBe(true);
    expect(readFileSync(urgent.briefPath, 'utf8')).toContain('"urgent": true');
    await call('urgent', ['grant', owner], parent);
    writeFileSync(h.briefFile, urgent.brief.markdown);
    await call('dispatch', [h.briefFile], owner);
    expect(started).toHaveLength(2);
    await call('status', [urgent.id]);
    expect(JSON.parse(printed.at(-1)!).urgent).toBe(true);
    await call('urgent', ['revoke', owner], parent);
    await expect(call('dispatch', [h.briefFile], owner)).rejects.toThrow('active urgent grant');
    writeFileSync(h.briefFile, urgent.brief.markdown.replace('"urgent": true', '"urgent": false'));
    h.store.db
      .query('INSERT OR REPLACE INTO manager_sessions VALUES (?,?)')
      .run(
        urgent.brief.manager,
        JSON.stringify({ id: urgent.brief.manager, status: 'running', threadId: 'owner-session' }),
      );
    expect(() =>
      h.tasks.amend(
        urgent.id,
        { expectedAttempt: 0, brief: h.briefFile },
        { id: urgent.brief.manager, sessionId: 'owner-session' },
      ),
    ).toThrow('urgent lane cannot change');
  } finally {
    h.dispose();
  }
});

test('reserved slots bypass ordinary starts, honour memory, free slots of waiting tasks and release on exit', async () => {
  const directory = temporaryDirectory(),
    db = openDb(':memory:'),
    store = new WorkerStore(db);
  const releases: (() => void)[] = [];
  try {
    const policy = { ...defaultPolicy.capacity, minAvailableMiB: 100, pollIntervalMs: 5 };
    expect(policy.urgentSlots).toBe(2);
    const capacity = join(directory.path, 'capacity.json');
    writeFileSync(capacity, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 100 }));
    for (const [index, id] of ['ordinary', 'one', 'two'].entries()) {
      db.query('INSERT INTO worker_tasks VALUES (?,?,?,?)').run(
        id,
        index + 1,
        1,
        JSON.stringify({ brief: { urgent: id !== 'ordinary' } }),
      );
      db.query('INSERT INTO worker_attempts VALUES (?,?,?)').run(
        id,
        1,
        JSON.stringify({ state: id === 'ordinary' ? 'running' : 'pending' }),
      );
    }
    let memory = 0,
      admitted = false;
    const options = { urgent: true, policy, availableMiB: () => memory };
    const ordinary = awaitHostCapacity(store, directory.path, false, 'queued', 1, {
      policy,
      availableMiB: () => memory,
    });
    const first = awaitHostCapacity(store, directory.path, false, 'one', 1, options).then((release) => {
      admitted = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(admitted).toBe(false);
    expect(capacityWaiters(directory.path)).toEqual(new Set(['queued', 'one']));
    memory = 100;
    releases.push(await first);
    releases.push(await awaitHostCapacity(store, directory.path, false, 'two', 1, options));
    let thirdStarted = false;
    const third = awaitHostCapacity(store, directory.path, false, 'three', 1, options).then((release) => {
      thirdStarted = true;
      return release;
    });
    db.query("UPDATE worker_attempts SET body=? WHERE task_id='one'").run(JSON.stringify({ state: 'waiting' }));
    releases[0]!();
    // A waiting attempt holds no session, so its urgent slot goes to the next start.
    expect(store.capacityAttemptsCount(true)).toBe(0);
    releases.push(await third);
    expect(thirdStarted).toBe(true);
    db.query("UPDATE worker_attempts SET body=? WHERE task_id='one'").run(JSON.stringify({ state: 'exited' }));
    expect(capacityWaiters(directory.path).has('queued')).toBe(true);
    db.query("UPDATE worker_attempts SET body=? WHERE task_id='ordinary'").run(JSON.stringify({ state: 'exited' }));
    releases.push(await ordinary); // Urgent reservations never use the ordinary slot.
    releases.forEach((release) => release());
    expect(capacityAvailable(store, directory.path)).toBe(true);
    // Even hosts without the ordinary opt-in file enforce the urgent lane's defaults.
    rmSync(capacity);
    memory = 0;
    let noOptInStarted = false;
    const noOptIn = awaitHostCapacity(store, directory.path, false, 'no-opt-in', 1, options).then((release) => {
      noOptInStarted = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(noOptInStarted).toBe(false);
    memory = 100;
    releases.push(await noOptIn);
  } finally {
    releases.forEach((release) => release());
    db.close();
    directory.close();
  }
});

test('urgent outcomes are marked and separate from report, flow and hourly throughput', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const at = '2026-11-04T01:10:00.000Z';
    h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
      current.brief.urgent = true;
    });
    for (const [stage, action] of [
      ['worker', 'started'],
      ['worker', 'finished'],
      ['integration', 'integrated'],
    ] as const)
      recordFlow(h.store.db, { taskId: task.id, attempt: 1, stage, action, at });
    const flow = flowReport(readFlow(h.store.db), readFlowTasks(h.store.db));
    expect(flow.urgent).toEqual({ tasks: [task.id], integrated: 1 });
    expect(flow.attemptsPerIntegrated).toBeNull();
    const hourly = await renderHourlyEfficiencyReport(h.store.db, { bucket: '2026-11-04T01:00:00.000Z' });
    expect(hourly).toContain('Landings in UTC hour: dev 0; stabilize 0; main 0; unknown 0');
    expect(hourly).toContain(`Urgent landings (excluded from throughput): ${task.id}#1`);
    expect(hourly).toContain('Urgent worker starts / finishes in bucket (excluded from throughput): 1 / 1');
    const record = makeRecord(
      h.store.task(task.id),
      {
        taskId: task.id,
        attempt: 1,
        profile: { cli: 'codex', model: 'test', effort: 'high', poolClass: 'codex' },
        startedAt: at,
        endedAt: at,
      } as never,
      {
        tokens: { input: 0, cached: 0, output: 0 },
        steps: { decision: 0, read: 0, edit: 0, wait: 0, check: 0, commit: 0 },
      } as never,
      'passed',
    );
    expect(record.urgent).toBe(true);
    expect(report([record])).toMatchObject({
      tasks: 0,
      passedTasks: 0,
      urgent: { tasks: [task.id], attempts: 1, passedTasks: 1 },
    });
  } finally {
    h.dispose();
  }
});
