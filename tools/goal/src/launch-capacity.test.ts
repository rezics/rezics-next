import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDirectoryLease } from './lease.ts';
import { processIdentity } from './process.ts';
import { StaleAttemptError } from './contracts.ts';
import { openDb } from './db.ts';
import {
  awaitHostCapacity,
  capacityAvailable,
  capacityWaiters,
  hasCapacity,
  startsFirst,
  waitersAhead,
} from './launch.ts';
import * as launchCapacity from './launch-capacity.ts';
import { admittedMemoryMiB } from './launch-capacity.ts';
import type { CapacityLifecycle } from './launch-capacity.ts';
import { defaultPolicy } from './policy.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';

function capacityStore(
  lifecycle: Map<string, CapacityLifecycle>,
  options: { urgentRunning?: number; ordinaryRunning?: number; attempts?: Map<string, { attempt: number; state: 'pending' | 'running' | 'waiting' }[]> } = {},
) {
  return {
    capacityAttemptsCount: (urgent: boolean) => (urgent ? (options.urgentRunning ?? 0) : (options.ordinaryRunning ?? 0)),
    attempts: (taskId: string) => options.attempts?.get(taskId) ?? [],
    capacityLifecycle: (taskId: string) => lifecycle.get(taskId),
    taskGoal: () => 'library',
    goalInFlightCount: () => 0,
  };
}
function liveTicketBody(value: Record<string, unknown>): string {
  const identity = processIdentity();
  if (!identity) throw new Error('test process identity unavailable');
  return JSON.stringify({ ...identity, ...value });
}

test('launch.ts re-exports the host-capacity implementation', () => {
  expect(awaitHostCapacity).toBe(launchCapacity.awaitHostCapacity);
  expect(capacityAvailable).toBe(launchCapacity.capacityAvailable);
  expect(capacityWaiters).toBe(launchCapacity.capacityWaiters);
  expect(hasCapacity).toBe(launchCapacity.hasCapacity);
  expect(startsFirst).toBe(launchCapacity.startsFirst);
  expect(waitersAhead).toBe(launchCapacity.waitersAhead);
});

test('concurrent starts respect the cap and a queued start proceeds after release', async () => {
  const directory = temporaryDirectory();
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  const releases: Array<() => void> = [];
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    const policy = { ...defaultPolicy.capacity, maxWorkers: 1, minAvailableMiB: 0, pollIntervalMs: 5 };
    releases.push(await awaitHostCapacity(store, directory.path, false, 'first', 1, { policy, pollIntervalMs: 5 }));
    expect(capacityAvailable(store, directory.path)).toBe(false);
    let secondStarted = false;
    const second = awaitHostCapacity(store, directory.path, false, 'second', 1, { policy, pollIntervalMs: 5 }).then(
      (release) => {
        secondStarted = true;
        return release;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondStarted).toBe(false);
    expect(capacityWaiters(directory.path).has('second')).toBe(true);
    releases[0]!();
    releases.push(await second);
    expect(secondStarted).toBe(true);
    expect(capacityAvailable(store, directory.path)).toBe(false);
  } finally {
    releases.forEach((release) => release());
    db.close();
    directory.close();
  }
});

test('an admitted ticket holds the slot until the attempt leaves pending, without a worker PID', async () => {
  const directory = temporaryDirectory();
  const db = openDb(':memory:');
  const store = new WorkerStore(db);
  let release: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'held',
      1,
      1,
      JSON.stringify({ id: 'held', currentAttempt: 1, state: 'ready' }),
    );
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'held',
      1,
      JSON.stringify({ taskId: 'held', attempt: 1, state: 'pending' }),
    );
    const policy = { ...defaultPolicy.capacity, maxWorkers: 1, minAvailableMiB: 0, reservationPollMs: 5 };
    const queue = join(directory.path, 'capacity-queue');
    const admitted = () => readdirSync(queue).filter((name) => name.endsWith('.admitted'));
    release = await awaitHostCapacity(store, directory.path, false, 'held', 1, { policy, pollIntervalMs: 5 });
    expect(admitted()).toHaveLength(1);
    expect(capacityAvailable(store, directory.path)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(admitted()).toHaveLength(1);
    expect(capacityAvailable(store, directory.path)).toBe(false);
    store.updateAttempt({ taskId: 'held', attempt: 1 }, (attempt) => {
      attempt.state = 'running';
    });
    for (let step = 0; step < 40 && admitted().length > 0; step += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(admitted()).toHaveLength(0);
    expect(capacityAvailable(store, directory.path)).toBe(false);
  } finally {
    release?.();
    db.close();
    directory.close();
  }
});

test('a cancelled wait and an opt-out leave no owned tickets', async () => {
  const directory = temporaryDirectory();
  const queue = join(directory.path, 'capacity-queue');
  const tickets = () => (existsSync(queue) ? readdirSync(queue) : []);
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    const failing = {
      capacityAttemptsCount() {
        throw new Error('capacity counter failed');
      },
      attempts() {
        return [];
      },
    };
    await expect(awaitHostCapacity(failing, directory.path, false, 'cancel')).rejects.toThrow(
      'capacity counter failed',
    );
    expect(tickets()).toEqual([]);

    mkdirSync(queue, { recursive: true });
    const db = openDb(':memory:');
    const store = new WorkerStore(db);
    try {
      writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 0, minAvailableMiB: 0 }));
      const waiting = awaitHostCapacity(store, directory.path, false, 'queued', 1, { pollIntervalMs: 5 });
      for (let step = 0; step < 40 && tickets().length === 0; step += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(tickets().some((name) => name.includes('-queued'))).toBe(true);
      rmSync(join(directory.path, 'capacity.json'));
      (await waiting)();
      expect(tickets()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    directory.close();
  }
});

test('urgent and ordinary reservations share one count and working-set budget', async () => {
  const directory = temporaryDirectory();
  const store = { capacityAttemptsCount: () => 0, attempts: () => [], taskGoal: () => 'library' };
  const releases: (() => void)[] = [];
  const options = {
    pollIntervalMs: 5,
    availableMiB: () => Infinity,
    pressure: () => ({ memoryFull: 0, ioFull: 0 }),
    workerHeadroomMiB: () => 4096,
  };
  try {
    writeFileSync(
      join(directory.path, 'capacity.json'),
      JSON.stringify({ maxWorkers: 2, urgentSlots: 2, minAvailableMiB: 0 }),
    );
    releases.push(await awaitHostCapacity(store, directory.path, false, 'ordinary', 1, options));
    releases.push(await awaitHostCapacity(store, directory.path, false, 'urgent', 1, { ...options, urgent: true }));
    let admitted = false;
    const third = awaitHostCapacity(store, directory.path, false, 'third', 1, { ...options, urgent: true }).then(
      (release) => {
        admitted = true;
        return release;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(admitted).toBe(false);
    // Raising the count alone cannot bypass reservations held in either lane.
    writeFileSync(
      join(directory.path, 'capacity.json'),
      JSON.stringify({ maxWorkers: 3, urgentSlots: 3, minAvailableMiB: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(admitted).toBe(false);
    releases[0]!();
    releases.push(await third);
    expect(admitted).toBe(true);
  } finally {
    releases.forEach((release) => release());
    directory.close();
  }
});

test('slice headroom, system memory and PSI each hold admission until available', async () => {
  const directory = temporaryDirectory();
  const store = { capacityAttemptsCount: () => 0, attempts: () => [], goalInFlightCount: () => 0 };
  let headroom = 2047;
  let available = 100;
  let pressure = { memoryFull: 0, ioFull: 0 };
  let now = 0;
  let started = false;
  let release: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 32, minAvailableMiB: 100 }));
    const policy = { ...defaultPolicy.capacity, maxWorkers: 32, minAvailableMiB: 100, pollIntervalMs: 5 };
    const pending = awaitHostCapacity(store, directory.path, false, 'independent', 1, {
      policy,
      pollIntervalMs: 5,
      goal: 'imports',
      goalMaxInFlight: Infinity,
      excludeTaskId: 'independent',
      availableMiB: () => available,
      pressure: () => pressure,
      now: () => now,
      workerHeadroomMiB: () => headroom,
    }).then((unlock) => {
      started = true;
      release = unlock;
      return unlock;
    });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
    await pause();
    expect(started).toBe(false);
    headroom = 2048;
    available = 99;
    await pause();
    expect(started).toBe(false);
    available = 100;
    pressure = { memoryFull: 1, ioFull: 0 };
    await pause();
    expect(started).toBe(false);
    pressure = { memoryFull: 0, ioFull: 0 };
    now = 1;
    await pause();
    expect(started).toBe(false);
    now = 31_001;
    await pending;
    expect(started).toBe(true);
  } finally {
    release?.();
    directory.close();
  }
});
test('a resumed attempt reserves four GiB on its ticket and transfers that charge only to its current writer', async () => {
  const directory = temporaryDirectory();
  const taskId = 'resumed-worker';
  let headroom = 3072;
  let release: (() => void) | undefined;
  const store = {
    capacityAttemptsCount: () => 0,
    attempts: () => [{ attempt: 1, state: 'waiting' as const }],
    goalInFlightCount: () => 0,
  };
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 32, minAvailableMiB: 0 }));
    const policy = { ...defaultPolicy.capacity, maxWorkers: 32, minAvailableMiB: 0, pollIntervalMs: 5 };
    const options = {
      policy,
      pollIntervalMs: 5,
      goal: 'library',
      goalMaxInFlight: Infinity,
      excludeTaskId: taskId,
      availableMiB: () => Infinity,
      pressure: () => ({ memoryFull: 0, ioFull: 0 }),
      workerHeadroomMiB: () => headroom,
    };
    const resumed = awaitHostCapacity(store, directory.path, false, taskId, 1, { ...options, resume: true });
    const queue = join(directory.path, 'capacity-queue');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const waiting = readdirSync(queue).find((name) => name.endsWith(`-${taskId}`))!;
    expect(JSON.parse(readFileSync(join(queue, waiting), 'utf8')).memoryMiB).toBe(4096);
    headroom = 4096;
    release = await resumed;
    const writer = JSON.stringify([taskId, 1]);
    expect(admittedMemoryMiB(directory.path, new Set())).toBe(4096);
    expect(admittedMemoryMiB(directory.path, new Set([writer]))).toBe(0);
    expect(admittedMemoryMiB(directory.path, new Set([JSON.stringify(['other-worker', 1])]))).toBe(4096);
  } finally {
    release?.();
    directory.close();
  }
});

test('an obsolete first-start ticket cannot block an independent urgent repair at width two', async () => {
  const directory = temporaryDirectory();
  const lifecycle = new Map<string, CapacityLifecycle>([
    ['live-worker', { currentAttempt: 1, taskState: 'running', attemptState: 'running' }],
    ['repair', { currentAttempt: 0, taskState: 'ready' }],
  ]);
  const store = capacityStore(lifecycle, { urgentRunning: 1 });
  let release: (() => void) | undefined;
  const queue = join(directory.path, 'urgent-capacity-queue');
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 2, urgentSlots: 2, minAvailableMiB: 0 }));
    mkdirSync(queue, { recursive: true });
    const obsolete = `000000000000001-${process.pid}-live-worker`;
    writeFileSync(join(queue, obsolete), liveTicketBody({ taskId: 'live-worker' }));
    release = await awaitHostCapacity(store, directory.path, false, 'repair', 1, {
      urgent: true,
      pollIntervalMs: 5,
      availableMiB: () => Infinity,
      pressure: () => ({ memoryFull: 0, ioFull: 0 }),
      workerHeadroomMiB: () => Infinity,
    });
    expect(existsSync(join(queue, obsolete))).toBe(false);
    expect(readdirSync(queue).filter((name) => name.endsWith('.admitted'))).toHaveLength(1);
    expect(capacityWaiters(directory.path, store)).toEqual(new Set(['repair']));
  } finally {
    release?.();
    directory.close();
  }
});

test('legacy live identity keeps an exact parked resume distinct from its superseded first start', () => {
  const directory = temporaryDirectory();
  const lifecycle = new Map<string, CapacityLifecycle>([
    [
      'parked',
      {
        currentAttempt: 1,
        taskState: 'running',
        attemptState: 'waiting',
        attemptStartedAt: '1970-01-01T00:00:00.001Z',
      },
    ],
  ]);
  const store = capacityStore(lifecycle);
  const queue = join(directory.path, 'urgent-capacity-queue');
  try {
    mkdirSync(queue, { recursive: true });
    const firstStart = `000000000000001-${process.pid}-parked`;
    const resume = `000000000000002-${process.pid}-parked.admitted`;
    const earlierResume = `000000000000002-${process.pid}-parked`;
    const repeatedResume = `000000000000003-${process.pid}-parked`;
    writeFileSync(join(queue, firstStart), liveTicketBody({ taskId: 'parked', attempt: 1 }));
    // Older tickets have no operation payload; the attempt's start time separates the stale start from later wakes.
    writeFileSync(join(queue, resume), JSON.stringify({ taskId: 'parked', attempt: 1 }));
    writeFileSync(join(queue, earlierResume), JSON.stringify({ taskId: 'parked', attempt: 1 }));
    writeFileSync(join(queue, repeatedResume), JSON.stringify({ taskId: 'parked', attempt: 1 }));

    expect(capacityWaiters(directory.path, store)).toEqual(new Set(['parked']));
    expect(existsSync(join(queue, firstStart))).toBe(false);
    expect(existsSync(join(queue, resume))).toBe(true);
    expect(waitersAhead(queue, repeatedResume, store)).toBe(0);
    expect(launchCapacity.admittedMemoryMiB(directory.path, new Set(), store)).toBe(4096);
  } finally {
    directory.close();
  }
});

test('overlapping starts share one reservation and the live successor exits when the generation advances', async () => {
  const directory = temporaryDirectory();
  const lifecycle = new Map<string, CapacityLifecycle>([['same-task', { currentAttempt: 0, taskState: 'ready' }]]);
  const attempts = new Map<string, { attempt: number; state: 'pending' | 'running' | 'waiting' }[]>();
  const store = capacityStore(lifecycle, { attempts });
  const queue = join(directory.path, 'capacity-queue');
  let ownerRelease: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 4, minAvailableMiB: 0 }));
    const options = {
      pollIntervalMs: 5,
      availableMiB: () => Infinity,
      pressure: () => ({ memoryFull: 0, ioFull: 0 }),
      workerHeadroomMiB: () => Infinity,
    };
    ownerRelease = await awaitHostCapacity(store, directory.path, false, 'same-task', 1, options);
    const successor = awaitHostCapacity(store, directory.path, false, 'same-task', 1, options);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(readdirSync(queue).filter((name) => name.endsWith('.admitted'))).toHaveLength(1);
    expect(readdirSync(queue).filter((name) => !name.endsWith('.admitted'))).toHaveLength(1);

    lifecycle.set('same-task', { currentAttempt: 1, taskState: 'running', attemptState: 'running' });
    attempts.set('same-task', [{ attempt: 1, state: 'running' }]);
    await expect(successor).rejects.toBeInstanceOf(StaleAttemptError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readdirSync(queue).filter((name) => name.endsWith('.admitted'))).toHaveLength(0);
  } finally {
    ownerRelease?.();
    directory.close();
  }
});

test('repeated check wakes for one parked generation keep one reservation and do not strand a stale wake', async () => {
  const directory = temporaryDirectory();
  const lifecycle = new Map<string, CapacityLifecycle>([
    ['parked', { currentAttempt: 1, taskState: 'running', attemptState: 'waiting' }],
  ]);
  const attempts = new Map<string, { attempt: number; state: 'pending' | 'running' | 'waiting' }[]>([
    ['parked', [{ attempt: 1, state: 'waiting' }]],
  ]);
  const store = capacityStore(lifecycle, { attempts });
  const queue = join(directory.path, 'capacity-queue');
  let ownerRelease: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 4, minAvailableMiB: 0 }));
    const options = {
      resume: true,
      pollIntervalMs: 5,
      availableMiB: () => Infinity,
      pressure: () => ({ memoryFull: 0, ioFull: 0 }),
      workerHeadroomMiB: () => 4096,
    };
    ownerRelease = await awaitHostCapacity(store, directory.path, false, 'parked', 1, options);
    const repeatedWake = awaitHostCapacity(store, directory.path, false, 'parked', 1, options);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(readdirSync(queue).filter((name) => name.endsWith('.admitted'))).toHaveLength(1);
    expect(readdirSync(queue).filter((name) => !name.endsWith('.admitted'))).toHaveLength(1);

    lifecycle.set('parked', { currentAttempt: 1, taskState: 'running', attemptState: 'running' });
    attempts.set('parked', [{ attempt: 1, state: 'running' }]);
    await expect(repeatedWake).rejects.toBeInstanceOf(StaleAttemptError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readdirSync(queue).filter((name) => name.endsWith('.admitted'))).toHaveLength(0);
  } finally {
    ownerRelease?.();
    directory.close();
  }
});

test('a dead ticket owner yields the same operation to its live successor', async () => {
  const directory = temporaryDirectory();
  const lifecycle = new Map<string, CapacityLifecycle>([
    ['recovered', { currentAttempt: 1, taskState: 'running', attemptState: 'pending' }],
  ]);
  const attempts = new Map<string, { attempt: number; state: 'pending' | 'running' | 'waiting' }[]>([
    ['recovered', [{ attempt: 1, state: 'pending' }]],
  ]);
  const store = capacityStore(lifecycle, { attempts });
  const queue = join(directory.path, 'capacity-queue');
  let release: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    mkdirSync(queue, { recursive: true });
    const dead = `000000000000001-2147483000-recovered`;
    writeFileSync(join(queue, dead), JSON.stringify({ pid: 2147483000, taskId: 'recovered', attempt: 1 }));
    release = await awaitHostCapacity(store, directory.path, false, 'recovered', 1, {
      pollIntervalMs: 5,
      availableMiB: () => Infinity,
      pressure: () => ({ memoryFull: 0, ioFull: 0 }),
      workerHeadroomMiB: () => Infinity,
    });
    expect(existsSync(join(queue, dead))).toBe(false);
    expect(readdirSync(queue).filter((name) => name.endsWith('.admitted'))).toHaveLength(1);
  } finally {
    release?.();
    directory.close();
  }
});

test('a bounded reclaim runs outside the admission lease and starts only after headroom is re-sampled', async () => {
  const directory = temporaryDirectory();
  let headroom = 0;
  let samples = 0;
  let reclaimCount = 0;
  let lockWasFree = false;
  let release: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 8, minAvailableMiB: 0 }));
    const pending = awaitHostCapacity(
      { capacityAttemptsCount: () => 0, attempts: () => [], taskGoal: () => 'library' },
      directory.path,
      false,
      'reclaim-success',
      1,
      {
        pollIntervalMs: 10,
        availableMiB: () => Infinity,
        pressure: () => ({ memoryFull: 0, ioFull: 0 }),
        workerHeadroomMiB: () => {
          samples += 1;
          return headroom;
        },
        reclaim: () => {
          reclaimCount += 1;
          const lease = acquireDirectoryLease(join(directory.path, 'capacity-admission-lock'));
          lockWasFree = true;
          lease.release();
          headroom = 2048;
        },
      },
    );
    release = await pending;
    expect(reclaimCount).toBe(1);
    expect(lockWasFree).toBe(true);
    expect(samples).toBeGreaterThanOrEqual(2);
  } finally {
    release?.();
    directory.close();
  }
});

test('an ineffective reclaim is coalesced until headroom recovers', async () => {
  const directory = temporaryDirectory();
  let headroom = 0;
  let reclaimCount = 0;
  let release: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 8, minAvailableMiB: 0 }));
    const pending = awaitHostCapacity(
      { capacityAttemptsCount: () => 0, attempts: () => [], taskGoal: () => 'library' },
      directory.path,
      false,
      'reclaim-no-effect',
      1,
      {
        pollIntervalMs: 5,
        availableMiB: () => Infinity,
        pressure: () => ({ memoryFull: 0, ioFull: 0 }),
        workerHeadroomMiB: () => headroom,
        reclaim: () => {
          reclaimCount += 1;
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(reclaimCount).toBe(1);
    headroom = 2048;
    release = await pending;
    expect(reclaimCount).toBe(1);
  } finally {
    release?.();
    directory.close();
  }
});

test('PSI pressure prevents cache reclaim even when the finite slice is the only capacity deficit', async () => {
  const directory = temporaryDirectory();
  let reclaimCount = 0;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 8, minAvailableMiB: 0 }));
    const pending = awaitHostCapacity(
      { capacityAttemptsCount: () => 0, attempts: () => [] },
      directory.path,
      false,
      'reclaim-pressure',
      1,
      {
        pollIntervalMs: 5,
        availableMiB: () => Infinity,
        pressure: () => ({ memoryFull: 1, ioFull: 0 }),
        workerHeadroomMiB: () => 0,
        reclaim: () => {
          reclaimCount += 1;
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reclaimCount).toBe(0);
    rmSync(join(directory.path, 'capacity.json'));
    (await pending)();
  } finally {
    directory.close();
  }
});
