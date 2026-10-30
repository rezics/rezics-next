import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitHostCapacity, capacityAvailable } from './launch.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';

test('admitted starts retain capacity throughout delayed preparation until running attempts take over', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-reservation-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 2, minAvailableMiB: 0 }));
    const ids = ['one', 'two', 'three', 'four'];
    for (const [sequence, id] of ids.entries()) {
      db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
        id,
        sequence + 1,
        1,
        '{}',
      );
      db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
        id,
        1,
        JSON.stringify({ state: 'pending' }),
      );
    }
    const preparing: string[] = [];
    const starts = ids.map(async (id) => {
      await awaitHostCapacity(store, directory, false, id);
      preparing.push(id);
      // Model the time spent rebasing and installing before launch records the attempt as running.
      await new Promise((resolve) => setTimeout(resolve, 400));
      db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
        JSON.stringify({ state: 'running' }),
        id,
        1,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const queue = join(directory, 'capacity-queue');
    const reservations = () => readdirSync(queue).filter((name) => name.endsWith('.admitted')).length;
    expect(preparing).toHaveLength(2);
    expect(store.runningAttemptsCount() + reservations()).toBe(2);
    expect(capacityAvailable(store, directory)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.runningAttemptsCount()).toBe(2);
    expect(reservations()).toBe(0);
    expect(store.runningAttemptsCount() + reservations()).toBe(2);
    expect(capacityAvailable(store, directory)).toBe(false);
    // The remaining starts stay queued; their unresolved waits are cleared by dropping opt-in capacity.
    writeFileSync(join(directory, 'capacity.json'), '{}');
    await Promise.all(starts);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('check-wake attempts do not count as running or admitted starts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-check-wake-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'wake',
      1,
      1,
      '{}',
    );
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'wake',
      1,
      JSON.stringify({ state: 'waiting' }),
    );
    expect(capacityAvailable(store, directory)).toBe(true);
    await awaitHostCapacity(store, directory, false, 'next');
    expect(capacityAvailable(store, directory)).toBe(false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an admitted ticket owned by a dead process does not hold capacity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-dead-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    const queue = join(directory, 'capacity-queue');
    Bun.spawnSync(['mkdir', '-p', queue]);
    writeFileSync(join(queue, `000000000000000-99999999-dead.admitted`), '');
    expect(capacityAvailable(store, directory)).toBe(true);
    expect(readdirSync(queue)).toHaveLength(0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed launch releases its admitted place for a later waiter', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-launch-failed-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'failed',
      1,
      1,
      '{}',
    );
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'failed',
      1,
      JSON.stringify({ state: 'pending' }),
    );
    await awaitHostCapacity(store, directory, false, 'failed');
    expect(capacityAvailable(store, directory)).toBe(false);

    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'exited' }),
      'failed',
      1,
    );
    const released = await Promise.race([
      (async () => {
        while (!capacityAvailable(store, directory)) await new Promise((resolve) => setTimeout(resolve, 25));
        return true;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    expect(released).toBe(true);
    await awaitHostCapacity(store, directory, false, 'later');
    expect(capacityAvailable(store, directory)).toBe(false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a capacity policy replacement wakes a queued start before the periodic poll', async () => {
  const temporary = join(process.cwd(), '.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'goal-admission-policy-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  let release: (() => void) | undefined;
  try {
    const policy = join(directory, 'capacity.json');
    writeFileSync(policy, JSON.stringify({ maxWorkers: 0, minAvailableMiB: 0 }));
    const admission = awaitHostCapacity(store, directory, false, 'policy-waiter');
    const queue = join(directory, 'capacity-queue');
    expect(readdirSync(queue).filter((name) => !name.endsWith('.admitted'))).toHaveLength(1);
    expect(capacityAvailable(store, directory)).toBe(false);
    const replacement = join(directory, 'capacity.next');
    writeFileSync(replacement, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    renameSync(replacement, policy);
    release = await admission;
    expect(readdirSync(queue).filter((name) => name.endsWith('.admitted'))).toHaveLength(1);
    expect(capacityAvailable(store, directory)).toBe(false);
    release();
    expect(capacityAvailable(store, directory)).toBe(true);
  } finally {
    release?.();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Admission with critical waiters cannot leave admissible capacity idle or indefinitely starve normal eligible starts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-admission-priority-fairness-'));
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  let releaseCritical: (() => void) | undefined;
  let releaseNormal: (() => void) | undefined;
  let releaseAgedCritical: (() => void) | undefined;
  let releaseAgedNormal: (() => void) | undefined;
  try {
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 2, minAvailableMiB: 0 }));
    const insertTask = db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
    const insertAttempt = db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)');
    for (const [sequence, id, state] of [
      [1, 'busy-one', 'running'],
      [2, 'busy-two', 'running'],
      [3, 'critical', 'pending'],
      [4, 'normal', 'pending'],
    ] as const) {
      insertTask.run(id, sequence, 1, '{}');
      insertAttempt.run(id, 1, JSON.stringify({ state }));
    }
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (condition()) return;
        await delay(5);
      }
      throw new Error('admission fixture did not reach the expected state');
    };
    const queue = join(directory, 'capacity-queue');
    const critical = awaitHostCapacity(store, directory, true, 'critical', 1, { pollIntervalMs: 5 });
    await waitFor(() => readdirSync(queue).filter((name) => !name.endsWith('.admitted')).length === 1);
    const normal = awaitHostCapacity(store, directory, false, 'normal', 1, { pollIntervalMs: 5 });
    await waitFor(() => readdirSync(queue).filter((name) => !name.endsWith('.admitted')).length === 2);

    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'exited' }),
      'busy-one',
      1,
    );
    releaseCritical = await critical;
    await waitFor(() => readdirSync(queue).some((name) => name.includes('-critical.admitted')));
    expect(store.runningAttemptsCount() + readdirSync(queue).filter((name) => name.endsWith('.admitted')).length).toBe(2);
    expect(readdirSync(queue).some((name) => name.includes('-normal.admitted'))).toBe(false);

    // The reservation remains attached to this critical incarnation through preparation and launch.
    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'running' }),
      'critical',
      1,
    );
    await waitFor(() => !readdirSync(queue).some((name) => name.includes('-critical.admitted')));
    expect(store.runningAttemptsCount()).toBe(2);

    // Once that incarnation exits, the older normal waiter takes the newly admissible place.
    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'exited' }),
      'critical',
      1,
    );
    releaseNormal = await normal;
    expect(readdirSync(queue).some((name) => name.includes('-normal.admitted'))).toBe(true);
    expect(store.runningAttemptsCount() + readdirSync(queue).filter((name) => name.endsWith('.admitted')).length).toBe(2);

    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'running' }),
      'normal',
      1,
    );
    await waitFor(() => !readdirSync(queue).some((name) => name.includes('-normal.admitted')));
    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'exited' }),
      'normal',
      1,
    );
    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'exited' }),
      'busy-two',
      1,
    );

    // A normal waiter older than the fixed critical head start must overtake a later critical arrival.
    const agedDirectory = join(directory, 'aged');
    mkdirSync(agedDirectory);
    writeFileSync(join(agedDirectory, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    for (const [sequence, id, state] of [
      [5, 'aged-busy', 'running'],
      [6, 'aged-normal', 'pending'],
      [7, 'aged-critical', 'pending'],
    ] as const) {
      insertTask.run(id, sequence, 1, '{}');
      insertAttempt.run(id, 1, JSON.stringify({ state }));
    }
    const agedNormal = awaitHostCapacity(store, agedDirectory, false, 'aged-normal', 1, {
      pollIntervalMs: 5,
      now: () => Date.now() - 31 * 60_000,
    });
    const agedQueue = join(agedDirectory, 'capacity-queue');
    await waitFor(() => readdirSync(agedQueue).filter((name) => !name.endsWith('.admitted')).length === 1);
    const agedCritical = awaitHostCapacity(store, agedDirectory, true, 'aged-critical', 1, { pollIntervalMs: 5 });
    await waitFor(() => readdirSync(agedQueue).filter((name) => !name.endsWith('.admitted')).length === 2);
    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'exited' }),
      'aged-busy',
      1,
    );
    releaseAgedNormal = await agedNormal;
    await waitFor(() => readdirSync(agedQueue).some((name) => name.includes('-aged-normal.admitted')));
    expect(readdirSync(agedQueue).some((name) => name.includes('-aged-critical.admitted'))).toBe(false);
    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'running' }),
      'aged-normal',
      1,
    );
    await waitFor(() => !readdirSync(agedQueue).some((name) => name.includes('-aged-normal.admitted')));
    db.query('UPDATE worker_attempts SET body = ? WHERE task_id = ? AND attempt = ?').run(
      JSON.stringify({ state: 'exited' }),
      'aged-normal',
      1,
    );
    releaseAgedCritical = await agedCritical;
    await waitFor(() => readdirSync(agedQueue).some((name) => name.includes('-aged-critical.admitted')));
  } finally {
    releaseCritical?.();
    releaseNormal?.();
    releaseAgedCritical?.();
    releaseAgedNormal?.();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
