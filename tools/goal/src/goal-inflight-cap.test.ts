import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backlogStatus, formatBacklogStatus } from './backlog.ts';
import { openDb } from './db.ts';
import { awaitHostCapacity } from './launch-capacity.ts';
import { defaultPolicy } from './policy.ts';
import { WorkerStore } from './store.ts';
import { checkSettings } from './settings.ts';

let sequence = 0;

function task(db: ReturnType<typeof openDb>, id: string, goal: string, state: string, urgent = false): void {
  sequence += 1;
  db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, 1, ?)').run(
    id,
    sequence,
    JSON.stringify({ id, currentAttempt: 1, state, brief: { goal, manager: goal, urgent } }),
  );
}

type CapacityOptions = NonNullable<Parameters<typeof awaitHostCapacity>[5]>;

function capacityOptions(goal: string, id: string, overrides: Partial<CapacityOptions> = {}): CapacityOptions {
  return {
    goal,
    goalMaxInFlight: 6,
    excludeTaskId: id,
    pollIntervalMs: 5,
    policy: { ...defaultPolicy.capacity, minAvailableMiB: 0, pollIntervalMs: 5, reservationPollMs: 5 },
    availableMiB: () => 1_000_000,
    ...overrides,
  };
}

function temporaryDirectory(): { path: string; close(): void } {
  const root = join(import.meta.dir, '../../../.temp/goal-inflight-cap');
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, 'case-'));
  return { path, close: () => rmSync(path, { recursive: true, force: true }) };
}

async function until(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error('timed out waiting for Goal start admission');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('the default and optional Goal cap use the existing local settings contract', () => {
  expect(defaultPolicy.goalMaxInFlight).toBe(6);
  const temporary = temporaryDirectory();
  try {
    const main = resolve(import.meta.dir, '../../..');
    const localFile = join(temporary.path, 'local.json');
    const options = { cwd: main, localFile, env: { GOAL_MAIN_CHECKOUT: main } };
    writeFileSync(localFile, JSON.stringify({ version: 1 }));
    expect(checkSettings(options).policy?.goalMaxInFlight).toBe(6);
    writeFileSync(localFile, JSON.stringify({ version: 1, policy: { goalMaxInFlight: 4 } }));
    expect(checkSettings(options).policy?.goalMaxInFlight).toBe(4);
  } finally {
    temporary.close();
  }
});

test('backlog status reports the in-flight count and configured cap for every active Goal', () => {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'goal.sqlite'));
  new WorkerStore(db);
  try {
    task(db, 'web-run', 'web', 'running');
    task(db, 'web-land', 'web', 'landing');
    task(db, 'web-urgent', 'web', 'running', true);
    task(db, 'control-plane-run', 'control-plane', 'running');

    const rows = backlogStatus(temporary.path, db, 4);

    expect(rows).toEqual([
      { goal: 'control-plane', ready: 0, dispatched: 0, failed: 0, returned: 0, inFlight: 1, maxInFlight: null },
      { goal: 'web', ready: 0, dispatched: 0, failed: 0, returned: 0, inFlight: 2, maxInFlight: 4 },
    ]);
    expect(formatBacklogStatus(rows)).toContain('in-flight');
    expect(formatBacklogStatus(rows)).toContain('exempt');
    expect(formatBacklogStatus(rows)).toContain('4');
  } finally {
    db.close();
    temporary.close();
  }
});

test('six running, check-parked or landing tasks block starts while ready work keeps same-Goal order', async () => {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'goal.sqlite'));
  const store = new WorkerStore(db);
  let firstRelease: (() => void) | undefined;
  let secondRelease: (() => void) | undefined;
  const pending: Promise<void>[] = [];
  try {
    for (let index = 0; index < 4; index += 1) task(db, `running-${index}`, 'web', 'running');
    task(db, 'parked-check', 'web', 'running');
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, 1, ?)').run(
      'parked-check',
      JSON.stringify({ taskId: 'parked-check', attempt: 1, state: 'waiting', checks: ['check'] }),
    );
    task(db, 'landing', 'web', 'landing');
    task(db, 'held-on-dependency', 'web', 'held');
    task(db, 'urgent-running', 'web', 'running', true);
    task(db, 'control-plane-running', 'control-plane', 'running');
    expect(store.goalInFlightCount('web')).toBe(6);
    expect(store.goalInFlightCount('control-plane')).toBe(0);

    const retry = await awaitHostCapacity(store, temporary.path, false, 'running-0', 2, {
      ...capacityOptions('web', 'running-0'),
    });
    retry();

    task(db, 'ready-z', 'web', 'ready');
    task(db, 'ready-a', 'web', 'ready');
    let firstStarted = false;
    let secondStarted = false;
    const second = awaitHostCapacity(store, temporary.path, false, 'ready-a', 1, {
      ...capacityOptions('web', 'ready-a'),
      now: () => Date.now() + 1,
    }).then((release) => {
      secondRelease = release;
      secondStarted = true;
    });
    pending.push(second);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondStarted).toBe(false);
    const readyBody = db.query('SELECT body FROM worker_tasks WHERE id=?').get('ready-a') as { body: string };
    expect((JSON.parse(readyBody.body) as { state: string }).state).toBe('ready');

    db.query("UPDATE worker_tasks SET body=json_set(body, '$.state', 'integrated') WHERE id=?").run('running-0');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstStarted).toBe(false);
    expect(secondStarted).toBe(false);

    const first = awaitHostCapacity(store, temporary.path, false, 'ready-z', 1, {
      ...capacityOptions('web', 'ready-z'),
      now: () => Date.now() + 2,
    }).then((release) => {
      firstRelease = release;
      firstStarted = true;
    });
    pending.push(first);
    await until(() => firstStarted);
    expect(secondStarted).toBe(false);

    db.query("UPDATE worker_tasks SET body=json_set(body, '$.state', 'running') WHERE id=?").run('ready-z');
    firstRelease?.();
    db.query("UPDATE worker_tasks SET body=json_set(body, '$.state', 'integrated') WHERE id=?").run('running-1');
    await until(() => secondStarted);
  } finally {
    firstRelease?.();
    secondRelease?.();
    db.query(
      "UPDATE worker_tasks SET body=json_set(body, '$.state', 'integrated') WHERE json_extract(body, '$.brief.goal') = 'web'",
    ).run();
    await Promise.allSettled(pending);
    firstRelease?.();
    secondRelease?.();
    db.close();
    temporary.close();
  }
});

test('urgent and control-plane starts bypass the per-Goal cap, while dependency-held work does not count', async () => {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'goal.sqlite'));
  const store = new WorkerStore(db);
  try {
    for (let index = 0; index < 6; index += 1) task(db, `web-${index}`, 'web', 'running');
    task(db, 'web-held', 'web', 'held');
    task(db, 'cp-one', 'control-plane', 'running');
    task(db, 'cp-two', 'control-plane', 'landing');
    expect(store.goalInFlightCount('web')).toBe(6);
    expect(store.goalInFlightCount('control-plane')).toBe(0);

    const urgentRelease = await awaitHostCapacity(store, temporary.path, false, 'urgent-next', 1, {
      ...capacityOptions('web', 'urgent-next', { urgent: true }),
    });
    const controlPlaneRelease = await awaitHostCapacity(store, temporary.path, false, 'cp-next', 1, {
      ...capacityOptions('control-plane', 'cp-next'),
    });
    urgentRelease();
    controlPlaneRelease();
    expect(store.goalInFlightCount('web')).toBe(6);
  } finally {
    db.close();
    temporary.close();
  }
});
