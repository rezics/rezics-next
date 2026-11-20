import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backlogStatus, formatBacklogStatus } from './backlog.ts';
import { openDb } from './db.ts';
import { awaitHostCapacity } from './launch-capacity.ts';
import { defaultPolicy } from './policy.ts';
import { WorkerStore } from './store.ts';
import { checkSettings } from './settings.ts';
import type { Attempt, Task } from './types.ts';

let sequence = 0;

function task(
  db: ReturnType<typeof openDb>,
  id: string,
  goal: string,
  state: Task['state'],
  urgent = false,
  attemptState: Attempt['state'] | undefined = state === 'running'
    ? 'running'
    : state === 'landing'
      ? 'exited'
      : undefined,
): void {
  sequence += 1;
  const currentAttempt = attemptState === undefined ? 0 : 1;
  db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
    id,
    sequence,
    currentAttempt,
    JSON.stringify({ id, currentAttempt, state, brief: { goal, manager: goal, urgent } }),
  );
  if (attemptState !== undefined)
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      id,
      currentAttempt,
      JSON.stringify({
        taskId: id,
        attempt: currentAttempt,
        state: attemptState,
        ...(attemptState === 'waiting' ? { checks: ['check'] } : {}),
      }),
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
    pressure: () => ({ memoryFull: 0, ioFull: 0 }),
    workerHeadroomMiB: () => Number.POSITIVE_INFINITY,
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
  const integrate = (id: string) =>
    db.transaction(() => {
      db.query("UPDATE worker_attempts SET body=json_set(body, '$.state', 'exited') WHERE task_id=? AND attempt=1").run(
        id,
      );
      db.query("UPDATE worker_tasks SET body=json_set(body, '$.state', 'integrated') WHERE id=?").run(id);
    })();
  try {
    for (let index = 0; index < 4; index += 1) task(db, `running-${index}`, 'web', 'running');
    task(db, 'parked-check', 'web', 'running', false, 'waiting');
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
    task(db, 'ready-a', 'web', 'ready', false, 'exited');
    await expect(
      awaitHostCapacity(store, temporary.path, false, 'ready-a', 1, capacityOptions('web', 'ready-a')),
    ).rejects.toThrow('attempt 0 of ready-a is stale');
    let firstStarted = false;
    let secondStarted = false;
    const secondWaits: (readonly string[])[] = [];
    const second = awaitHostCapacity(store, temporary.path, false, 'ready-a', 2, {
      ...capacityOptions('web', 'ready-a'),
      now: () => Date.now() + 1,
      onWaitReasons: (reasons) => secondWaits.push(reasons),
    }).then((release) => {
      secondRelease = release;
      secondStarted = true;
    });
    pending.push(second);
    void second.catch(() => {});

    await until(() => secondWaits.length > 0);
    expect(secondWaits[0]).toContain('goal-start-limit');
    expect(secondStarted).toBe(false);
    const readyBody = db.query('SELECT body FROM worker_tasks WHERE id=?').get('ready-a') as { body: string };
    expect((JSON.parse(readyBody.body) as { state: string }).state).toBe('ready');

    integrate('running-0');
    const checksBeforeFreeing = secondWaits.length;
    await until(() => secondWaits.length > checksBeforeFreeing);
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
    void first.catch(() => {});
    await until(() => firstStarted);
    expect(secondStarted).toBe(false);

    db.transaction(() => {
      db.query(
        "UPDATE worker_tasks SET current_attempt=1, body=json_set(body, '$.state', 'running', '$.currentAttempt', 1) WHERE id=?",
      ).run('ready-z');
      db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, 1, ?)').run(
        'ready-z',
        JSON.stringify({ taskId: 'ready-z', attempt: 1, state: 'running' }),
      );
    })();
    firstRelease?.();
    integrate('running-1');
    await until(() => secondStarted);
    expect(store.capacityLifecycle('ready-a')).toMatchObject({ currentAttempt: 1, attemptState: 'exited' });
  } finally {
    firstRelease?.();
    secondRelease?.();
    db.query(
      "UPDATE worker_tasks SET body=json_set(body, '$.state', 'cancelled') WHERE json_extract(body, '$.state') = 'ready'",
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
    task(db, 'urgent-next', 'web', 'ready', true);
    task(db, 'cp-next', 'control-plane', 'ready');
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
