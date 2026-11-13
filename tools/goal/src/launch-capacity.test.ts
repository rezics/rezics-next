import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { physicalHistoryPath } from '../../../scripts/check-custody.ts';
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
import type { CapacityLifecycle, CapacityRelease, HostCapacityStore } from './launch-capacity.ts';
import { HEAVY_WORKER_MIB, workerHeadroomMiB, workerMemoryCurrentMiB } from './host-pressure.ts';
import { defaultPolicy } from './policy.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';

function capacityStore(
  lifecycle: Map<string, CapacityLifecycle>,
  options: {
    urgentRunning?: number;
    ordinaryRunning?: number;
    attempts?: Map<string, { attempt: number; state: 'pending' | 'running' | 'waiting' }[]>;
  } = {},
) {
  return {
    capacityAttemptsCount: (urgent: boolean) =>
      urgent ? (options.urgentRunning ?? 0) : (options.ordinaryRunning ?? 0),
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

function terminalRemoteCheckFixture(directory: string) {
  const taskId = 'capacity-owner';
  const worktree = join(directory, 'worktree');
  const resultDirectory = join(worktree, '.temp/goal/checks/results');
  const historyDirectory = join(worktree, '.temp/goal/checks/custody/history');
  const sliceRoot = join(directory, 'slice');
  const checkId = randomUUID();
  const physicalRunId = randomUUID();
  const historyPath = physicalHistoryPath(worktree, checkId, physicalRunId);
  const identity = processIdentity();
  if (!identity) throw new Error('test process identity unavailable');
  const terminalRunner = { pid: 999_999_999, start: '1', boot: identity.boot, group: 999_999_999 };
  mkdirSync(resultDirectory, { recursive: true });
  mkdirSync(historyDirectory, { recursive: true });
  mkdirSync(sliceRoot, { recursive: true });
  const terminalScope = `rezics-worker-${taskId}-1-oldscope.scope`;
  const unknownScope = 'rezics-worker-unrelated-1-unknown.scope';
  const scope = (name: string, currentGiB: number, peakGiB: number) => {
    mkdirSync(join(sliceRoot, name), { recursive: true });
    writeFileSync(join(sliceRoot, name, 'memory.current'), String(Math.round(currentGiB * 1024 ** 3)));
    writeFileSync(join(sliceRoot, name, 'memory.peak'), String(Math.round(peakGiB * 1024 ** 3)));
  };
  writeFileSync(join(sliceRoot, 'memory.max'), String(26 * 1024 ** 3));
  writeFileSync(join(sliceRoot, 'memory.current'), String(10 * 1024 ** 3));
  scope(terminalScope, 0.04, 3.7);
  scope(unknownScope, 0.1, 4.5);
  writeFileSync(
    join(resultDirectory, `${checkId}.json`),
    JSON.stringify({
      id: checkId,
      cwd: worktree,
      argv: ['bun', 'test', 'tests/example.test.ts'],
      status: 'finished',
      log: join(worktree, '.temp/goal/checks/logs', `${checkId}.log`),
      ownership: { taskId, attempt: 1 },
      physicalRunId,
      runnerHost: hostname(),
      exitCode: 2,
    }),
  );
  writeFileSync(
    historyPath,
    JSON.stringify({
      version: 1,
      id: checkId,
      cwd: worktree,
      argv: ['bun', 'test', 'tests/example.test.ts'],
      ownership: { taskId, attempt: 1 },
      physicalRunId,
      runnerHost: hostname(),
      runnerIdentity: terminalRunner,
      log: join(worktree, '.temp/goal/checks/logs', `${checkId}.log`),
      status: 'finished',
      remoteExpected: true,
      terminalProof: { local: true, remote: null, resultKnown: true, observedAt: new Date().toISOString() },
      exitCode: 2,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }),
  );
  let attemptState: 'waiting' | 'running' = 'waiting';
  const row: { task_id: string; current_attempt: number; attempt_state: string; body: string; worktree: string } = {
    task_id: taskId,
    current_attempt: 1,
    attempt_state: attemptState,
    body: '',
    worktree,
  };
  const updateAttempt = (state: 'waiting' | 'running') => {
    attemptState = state;
    row.attempt_state = state;
    row.body = JSON.stringify({
      taskId,
      attempt: 1,
      state,
      process: state === 'running' ? processIdentity() : null,
      checks: [checkId],
    });
  };
  updateAttempt('waiting');
  const store = {
    db: { query: () => ({ all: () => [row] }) },
    capacityAttemptsCount: () => (attemptState === 'running' ? 1 : 0),
    attempts: () => [{ attempt: 1, state: attemptState }],
    taskGoal: () => 'library',
  } as unknown as HostCapacityStore;
  return { taskId, checkId, sliceRoot, terminalScope, unknownScope, historyPath, store, updateAttempt };
}

test('launch.ts re-exports the host-capacity implementation', () => {
  expect(awaitHostCapacity).toBe(launchCapacity.awaitHostCapacity);
  expect(capacityAvailable).toBe(launchCapacity.capacityAvailable);
  expect(capacityWaiters).toBe(launchCapacity.capacityWaiters);
  expect(hasCapacity).toBe(launchCapacity.hasCapacity);
  expect(startsFirst).toBe(launchCapacity.startsFirst);
  expect(waitersAhead).toBe(launchCapacity.waitersAhead);
});

test('legacy unkeyed tickets remain ahead in the FIFO queue', () => {
  const directory = temporaryDirectory();
  const queue = join(directory.path, 'capacity-queue');
  mkdirSync(queue, { recursive: true });
  const now = Date.now();
  const older = `${String(now - 60_000).padStart(15, '0')}-${process.pid}-older`;
  const mine = `${String(now).padStart(15, '0')}.00000001-${process.pid}-mine`;
  try {
    writeFileSync(join(queue, older), '');
    writeFileSync(join(queue, mine), '');
    expect(waitersAhead(queue, mine)).toBe(1);
    expect(waitersAhead(queue, older)).toBe(0);
  } finally {
    directory.close();
  }
});

test('exact completed-check resumes outrank recent starts, coalesce on restart, and yield to aged starts', () => {
  const directory = temporaryDirectory();
  const queue = join(directory.path, 'capacity-queue');
  mkdirSync(queue, { recursive: true });
  const identity = processIdentity();
  if (!identity) throw new Error('test process identity unavailable');
  const now = Date.now();
  const fairness = defaultPolicy.capacity.criticalHeadStartMs;
  const save = (name: string, metadata: Record<string, unknown>) =>
    writeFileSync(join(queue, name), JSON.stringify({ ...identity, ...metadata }));
  const oldStart = `${String(now - fairness - 1_000).padStart(15, '0')}.00000001-${process.pid}-old-start`;
  const firstResume = `${String(now - 100).padStart(15, '0')}.00000002-${process.pid}-resume-a`;
  const restartedResume = `${String(now - 50).padStart(15, '0')}.00000003-${process.pid}-resume-a-restart`;
  const secondResume = `${String(now - 25).padStart(15, '0')}.00000004-${process.pid}-resume-b`;
  const recentStart = `${String(now).padStart(15, '0')}.00000005-${process.pid}-recent-start`;
  const readyTicket = (taskId: string, readyId: string, ticketId: string, queuedAt: number) => ({
    taskId,
    attempt: 1,
    operation: 'resume',
    queuedAt,
    resumePriority: true,
    resumeReadyOperationId: readyId,
    resumeTicketId: ticketId,
    memoryMiB: 4096,
  });
  try {
    save(oldStart, {
      taskId: 'old-start',
      attempt: 1,
      operation: 'start',
      queuedAt: now - fairness - 1_000,
      memoryMiB: 2048,
    });
    save(firstResume, readyTicket('resume-a', 'ready-a', 'ticket-a', now - 100));
    save(restartedResume, readyTicket('resume-a', 'ready-a', 'ticket-a-restarted', now - 50));
    save(secondResume, readyTicket('resume-b', 'ready-b', 'ticket-b', now - 25));
    save(recentStart, {
      taskId: 'recent-start',
      attempt: 1,
      operation: 'start',
      queuedAt: now,
      memoryMiB: 2048,
    });

    expect(waitersAhead(queue, oldStart)).toBe(0);
    expect(waitersAhead(queue, firstResume)).toBe(1);
    expect(waitersAhead(queue, secondResume)).toBe(2);
    // A restarted duplicate for resume-a occupies no second FIFO position.
    expect(waitersAhead(queue, recentStart)).toBe(3);
  } finally {
    directory.close();
  }
});

test('legacy critical-start ordering does not make a recent fresh ticket appear aged', () => {
  const directory = temporaryDirectory();
  const queue = join(directory.path, 'capacity-queue');
  mkdirSync(queue, { recursive: true });
  const identity = processIdentity();
  if (!identity) throw new Error('test process identity unavailable');
  const now = Date.now();
  const fairness = defaultPolicy.capacity.criticalHeadStartMs;
  const legacyOrder = now - fairness - 500;
  const oldCriticalStart = `${String(legacyOrder).padStart(15, '0')}.00000001-${process.pid}-legacy-critical`;
  const readyResume = `${String(now - 100).padStart(15, '0')}.00000002-${process.pid}-ready-resume`;
  const lifecycle = new Map<string, CapacityLifecycle>([
    ['legacy-critical', { currentAttempt: 0, taskState: 'ready', priorityHeadStart: true }],
  ]);
  try {
    writeFileSync(
      join(queue, oldCriticalStart),
      JSON.stringify({ ...identity, taskId: 'legacy-critical', attempt: 1, operation: 'start', memoryMiB: 2048 }),
    );
    writeFileSync(
      join(queue, readyResume),
      JSON.stringify({
        ...identity,
        taskId: 'ready-resume',
        attempt: 1,
        operation: 'resume',
        queuedAt: now - 100,
        resumePriority: true,
        resumeReadyOperationId: 'terminal-check',
      }),
    );
    expect(waitersAhead(queue, readyResume, capacityStore(lifecycle))).toBe(0);
  } finally {
    directory.close();
  }
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
  let release: CapacityRelease | undefined;
  const store = {
    capacityAttemptsCount: () => 0,
    attempts: () => [{ attempt: 1, state: 'waiting' as const }],
    goalInFlightCount: () => 0,
  };
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 32, minAvailableMiB: 0 }));
    const policy = { ...defaultPolicy.capacity, maxWorkers: 32, minAvailableMiB: 0, pollIntervalMs: 5 };
    const waitReasons: string[] = [];
    const options = {
      policy,
      pollIntervalMs: 5,
      goal: 'library',
      goalMaxInFlight: Infinity,
      excludeTaskId: taskId,
      availableMiB: () => Infinity,
      pressure: () => ({ memoryFull: 0, ioFull: 0 }),
      workerHeadroomMiB: () => headroom,
      resumeReadyOperationId: 'ready-check-set',
      resumeTicketId: 'resume-ticket',
      onWaitReasons: (reasons: readonly string[]) => waitReasons.push(...reasons),
    };
    const resumed = awaitHostCapacity(store, directory.path, false, taskId, 1, { ...options, resume: true });
    const queue = join(directory.path, 'capacity-queue');
    await new Promise((resolve) => setTimeout(resolve, 15));
    const waiting = readdirSync(queue).find((name) => name.endsWith(`-${taskId}`))!;
    expect(JSON.parse(readFileSync(join(queue, waiting), 'utf8'))).toMatchObject({
      memoryMiB: 4096,
      resumeReadyOperationId: 'ready-check-set',
      resumeTicketId: 'resume-ticket',
      resumePriority: true,
    });
    expect(waitReasons).toContain('worker-slice-reserve');
    expect(waiting.endsWith('.admitted')).toBe(false);
    expect(admittedMemoryMiB(directory.path, new Set())).toBe(0);
    headroom = 4096;
    release = await resumed;
    expect(release.ticketId).toBe('resume-ticket');
    const writer = JSON.stringify([taskId, 1]);
    expect(admittedMemoryMiB(directory.path, new Set())).toBe(4096);
    expect(admittedMemoryMiB(directory.path, new Set([writer]))).toBe(0);
    expect(admittedMemoryMiB(directory.path, new Set([JSON.stringify(['other-worker', 1])]))).toBe(4096);
  } finally {
    release?.();
    directory.close();
  }
});

test('terminal local check proof releases only its waiting generation reserve and a replacement writer keeps it', async () => {
  const directory = temporaryDirectory();
  const fixture = terminalRemoteCheckFixture(directory.path);
  let release: (() => void) | undefined;
  let pendingReplacement: Promise<() => void> | undefined;
  let replacementStarted = false;
  let parked = new Set<string>();
  const capacity = { maxWorkers: 8, minAvailableMiB: 0 };
  const headroom: typeof workerHeadroomMiB = (
    running,
    root = fixture.sliceRoot,
    scopes = new Set(),
    active = new Set(),
  ) => {
    parked = new Set(scopes);
    return workerHeadroomMiB(running, root, scopes, active);
  };
  const options = {
    pollIntervalMs: 5,
    availableMiB: () => Infinity,
    pressure: () => ({ memoryFull: 0, ioFull: 0 }),
    workerSliceRoot: fixture.sliceRoot,
    memoryCurrentMiB: () => workerMemoryCurrentMiB(fixture.sliceRoot),
    workerHeadroomMiB: headroom,
    resume: true,
  };
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify(capacity));
    const memoryBefore = workerMemoryCurrentMiB(fixture.sliceRoot);
    const before = workerHeadroomMiB(0, fixture.sliceRoot, new Set(), new Set());
    release = await awaitHostCapacity(fixture.store, directory.path, false, fixture.taskId, 1, options);
    const after = workerHeadroomMiB(0, fixture.sliceRoot, parked, new Set());
    expect(parked).toContain(fixture.terminalScope);
    expect(parked).not.toContain(fixture.unknownScope);
    expect(after - before).toBeCloseTo(3.96 * 1024, 1);
    expect(workerMemoryCurrentMiB(fixture.sliceRoot)).toBe(memoryBefore);
    expect(readFileSync(join(fixture.sliceRoot, fixture.terminalScope, 'memory.current'), 'utf8')).toBe(
      String(Math.round(0.04 * 1024 ** 3)),
    );
    release();
    release = undefined;

    fixture.updateAttempt('running');
    pendingReplacement = awaitHostCapacity(fixture.store, directory.path, false, fixture.taskId, 1, options).then(
      (dispose) => {
        replacementStarted = true;
        return dispose;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(replacementStarted).toBe(false);
    expect(parked).not.toContain(fixture.terminalScope);
    expect(workerHeadroomMiB(1, fixture.sliceRoot, parked, new Set())).toBeLessThan(HEAVY_WORKER_MIB);
    rmSync(join(directory.path, 'capacity.json'), { force: true });
    release = await pendingReplacement;
    pendingReplacement = undefined;
  } finally {
    rmSync(join(directory.path, 'capacity.json'), { force: true });
    if (pendingReplacement) release = await pendingReplacement;
    release?.();
    directory.close();
  }
});

test('a legacy reclaim latch reopens once exact terminal custody proves its old scope reserve is obsolete', async () => {
  const directory = temporaryDirectory();
  const fixture = terminalRemoteCheckFixture(directory.path);
  let headroom = 0;
  let reclaimCount = 0;
  let terminalScopes = new Set<string>();
  let release: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 8, minAvailableMiB: 0 }));
    writeFileSync(join(directory.path, 'capacity-reclaim.json'), JSON.stringify({ blocked: true }));
    release = await awaitHostCapacity(fixture.store, directory.path, false, fixture.taskId, 1, {
      pollIntervalMs: 5,
      availableMiB: () => Infinity,
      pressure: () => ({ memoryFull: 0, ioFull: 0 }),
      workerSliceRoot: fixture.sliceRoot,
      memoryCurrentMiB: () => workerMemoryCurrentMiB(fixture.sliceRoot),
      workerHeadroomMiB: (_running, _root, parked) => {
        terminalScopes = new Set(parked);
        return headroom;
      },
      reclaim: () => {
        reclaimCount += 1;
        headroom = 2048;
        return { requestedMiB: 256 };
      },
    });

    const episode = JSON.parse(readFileSync(join(directory.path, 'capacity-reclaim.json'), 'utf8'));
    expect(reclaimCount).toBe(1);
    expect(terminalScopes).toContain(fixture.terminalScope);
    expect(episode.history.at(-1)).toMatchObject({
      outcome: 'no-progress',
      requestedMiB: 256,
      memoryProgressMiB: 0,
    });
  } finally {
    release?.();
    directory.close();
  }
});

test('missing physical custody evidence keeps the scope reserve and reports the exact wait cause', async () => {
  const directory = temporaryDirectory();
  const fixture = terminalRemoteCheckFixture(directory.path);
  rmSync(fixture.historyPath);
  let release: (() => void) | undefined;
  let parked = new Set<string>();
  const logged: string[] = [];
  const originalError = console.error;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 8, minAvailableMiB: 0 }));
    console.error = (...args) => logged.push(args.map(String).join(' '));
    const pending = awaitHostCapacity(fixture.store, directory.path, false, fixture.taskId, 1, {
      pollIntervalMs: 5,
      availableMiB: () => Infinity,
      pressure: () => ({ memoryFull: 0, ioFull: 0 }),
      workerSliceRoot: fixture.sliceRoot,
      workerHeadroomMiB: (_running, _root, scopes) => {
        parked = new Set(scopes);
        return 0;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(parked).not.toContain(fixture.terminalScope);
    expect(logged.join('\n')).toContain(
      `attempt ${fixture.taskId}/1 check ${fixture.checkId}: custody evidence is unavailable (ENOENT); scope reserve retained`,
    );

    rmSync(join(directory.path, 'capacity.json'));
    release = await pending;
  } finally {
    console.error = originalError;
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
    writeFileSync(
      join(directory.path, 'capacity.json'),
      JSON.stringify({ maxWorkers: 2, urgentSlots: 2, minAvailableMiB: 0 }),
    );
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

test('legacy reclaim history ignores cache estimates and retries only after measured memory progress', async () => {
  const directory = temporaryDirectory();
  let headroom = 0;
  let memoryCurrent = 10_000;
  let now = 1_000;
  let reclaimCount = 0;
  let release: (() => void) | undefined;
  try {
    writeFileSync(join(directory.path, 'capacity.json'), JSON.stringify({ maxWorkers: 8, minAvailableMiB: 0 }));
    writeFileSync(
      join(directory.path, 'capacity-reclaim.json'),
      JSON.stringify({
        version: 1,
        history: [
          {
            at: 900,
            outcome: 'progress',
            headroomBeforeMiB: 0,
            headroomAfterMiB: 0,
            cleanCacheBeforeMiB: 1024,
            cleanCacheAfterMiB: 0,
            requestedMiB: 1024,
            headroomProgressMiB: 0,
            cacheProgressMiB: 1024,
          },
        ],
      }),
    );
    const pending = awaitHostCapacity(
      { capacityAttemptsCount: () => 0, attempts: () => [], taskGoal: () => 'library' },
      directory.path,
      false,
      'reclaim-no-effect',
      1,
      {
        pollIntervalMs: 5,
        now: () => now,
        availableMiB: () => Infinity,
        pressure: () => ({ memoryFull: 0, ioFull: 0 }),
        workerHeadroomMiB: () => headroom,
        memoryCurrentMiB: () => memoryCurrent,
        reclaim: () => {
          reclaimCount += 1;
          if (reclaimCount === 2) headroom = 2048;
          return { requestedMiB: 1024 };
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reclaimCount).toBe(0);
    now += 1_001;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reclaimCount).toBe(0);
    memoryCurrent -= 64;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reclaimCount).toBe(1);
    now += 1_001;
    memoryCurrent -= 64;
    release = await pending;
    const episode = JSON.parse(readFileSync(join(directory.path, 'capacity-reclaim.json'), 'utf8'));
    expect(reclaimCount).toBe(2);
    expect(episode.history[0]).toMatchObject({
      outcome: 'legacy',
      requestedMiB: 1024,
      memoryCurrentAfterMiB: 10_000,
    });
    expect(episode.history[1]).toMatchObject({
      outcome: 'no-progress',
      memoryCurrentBeforeMiB: 9_936,
      memoryCurrentAfterMiB: 9_936,
      memoryProgressMiB: 0,
    });
    expect(episode.history[2]).toMatchObject({
      memoryCurrentBeforeMiB: 9_872,
      requestedMiB: 1024,
    });
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
