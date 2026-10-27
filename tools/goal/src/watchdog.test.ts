import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrate, openDb } from './db.ts';
import { violations, watch } from './watchdog.ts';
import { workerMigrations, WorkerStore } from './store.ts';
import type { Attempt, RetryIntent, Task } from './types.ts';

const now = Date.parse('2026-10-26T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
function temporaryDirectory(prefix: string): string {
  const directory = join(import.meta.dir, '../../../.temp');
  mkdirSync(directory, { recursive: true });
  return mkdtempSync(join(directory, prefix));
}

function store(tasks: Partial<Task>[], attempts: Partial<Attempt>[], intents: Partial<RetryIntent>[] = []) {
  return {
    tasks: () => tasks.map((task) => ({ brief: { goal: 'accounts' }, ...task }) as Task),
    attempt: (ref: { taskId: string; attempt: number }) =>
      attempts.find((attempt) => attempt.taskId === ref.taskId && attempt.attempt === ref.attempt) as Attempt,
    retryIntents: () => intents as RetryIntent[],
    attemptsEndedBetween: (start: string, end: string) =>
      attempts.filter(
        (attempt) =>
          typeof attempt.endedAt === 'string' &&
          Date.parse(attempt.endedAt) >= Date.parse(start) &&
          Date.parse(attempt.endedAt) <= Date.parse(end),
      ) as Attempt[],
  };
}

test('a running task whose attempt ended and that nothing will retry is a violation after ten minutes', () => {
  const tasks = [
    { id: 'stuck', state: 'running' as const, currentAttempt: 2 },
    { id: 'recent', state: 'running' as const, currentAttempt: 1 },
    { id: 'live', state: 'running' as const, currentAttempt: 1 },
    { id: 'queued', state: 'ready' as const, currentAttempt: 1 },
    { id: 'lost', state: 'ready' as const, currentAttempt: 3 },
  ];
  const attempts = [
    { taskId: 'stuck', attempt: 2, state: 'exited' as const, endedAt: minutesAgo(30) },
    { taskId: 'recent', attempt: 1, state: 'exited' as const, endedAt: minutesAgo(2) },
    { taskId: 'live', attempt: 1, state: 'running' as const, endedAt: null },
    { taskId: 'queued', attempt: 1, state: 'exited' as const, endedAt: minutesAgo(30) },
    { taskId: 'lost', attempt: 3, state: 'exited' as const, endedAt: minutesAgo(45) },
  ];
  const intents = [{ taskId: 'lost', attempt: 3, status: 'pending' as const }];
  const found = violations(store(tasks, attempts, intents), now);
  expect(found.map((violation) => violation.key)).toEqual(['no-worker:stuck:2', 'no-worker:lost:3']);
  expect(found[1]!.summary).toContain('pending retry for 45 min');
});

test('stabilize missing from dev is reported after thirty minutes, once per period, and forgotten once merged', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-watchdog-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  try {
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
    git('branch', 'dev');
    git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fix');
    git('branch', 'stabilize');
    const empty = store([], []);
    const branches = { stabilize: 'stabilize', integration: 'dev' };
    const delivered: string[] = [];
    const deliver = (summary: string) => delivered.push(summary);

    expect(watch(empty, root, branches, root, deliver, now)).toBe(0);
    expect(watch(empty, root, branches, root, deliver, now + 31 * 60_000)).toBe(1);
    expect(watch(empty, root, branches, root, deliver, now + 40 * 60_000)).toBe(0);
    expect(delivered[0]).toContain('dev has not contained stabilize for 31 min');

    git('branch', '-f', 'dev', 'stabilize');
    expect(watch(empty, root, branches, root, deliver, now + 50 * 60_000)).toBe(0);
    git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'next');
    git('branch', '-f', 'stabilize', 'main');
    expect(watch(empty, root, branches, root, deliver, now + 60 * 60_000)).toBe(0);
    expect(watch(empty, root, branches, root, deliver, now + 95 * 60_000)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a shared failure signature reports its attempts, tasks, goals and one example once per alert period', () => {
  const root = temporaryDirectory('goal-watchdog-signatures-');
  try {
    const tasks = [
      { id: 'accounts-1', state: 'integrated' as const, currentAttempt: 2, brief: { goal: 'accounts' } },
      { id: 'billing-1', state: 'integrated' as const, currentAttempt: 1, brief: { goal: 'billing' } },
    ] as unknown as Partial<Task>[];
    const attempts: Partial<Attempt>[] = [
      {
        taskId: 'accounts-1',
        attempt: 1,
        state: 'exited',
        endedAt: minutesAgo(3),
        result: 'SSH exit 255: host refused the connection',
      },
      {
        taskId: 'accounts-1',
        attempt: 2,
        state: 'exited',
        endedAt: minutesAgo(8),
        result: 'SSH exit 255: host refused the connection',
      },
      {
        taskId: 'billing-1',
        attempt: 1,
        state: 'exited',
        endedAt: minutesAgo(27),
        blocker: 'SSH exit 255: host refused the connection',
      },
      {
        taskId: 'billing-1',
        attempt: 2,
        state: 'exited',
        endedAt: minutesAgo(31),
        result: 'SSH exit 255: too old to count',
      },
    ];
    const tasksStore = store(tasks, attempts);
    const delivered: string[] = [];
    const branches = { stabilize: 'missing-stabilize', integration: 'missing-dev' };

    expect(watch(tasksStore, root, branches, root, (message) => delivered.push(message), now)).toBe(1);
    expect(delivered).toEqual([
      'Incident: check-host transport: 3 attempts of 2 tasks in 30 min (accounts, billing), e.g. accounts-1 attempt 1: SSH exit 255: host refused the connection',
    ]);
    expect(watch(tasksStore, root, branches, root, (message) => delivered.push(message), now + 60_000)).toBe(0);

    for (const attempt of attempts) {
      if (attempt.endedAt) attempt.endedAt = new Date(Date.parse(attempt.endedAt) + 121 * 60_000).toISOString();
    }
    expect(watch(tasksStore, root, branches, root, (message) => delivered.push(message), now + 121 * 60_000)).toBe(1);
    expect(delivered).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failure signatures classify each documented infrastructure error', () => {
  const root = temporaryDirectory('goal-watchdog-signature-kinds-');
  try {
    const kinds: [string, string][] = [
      ['model capacity', 'Selected model is at capacity'],
      ['allowance exhausted', 'Usage limit reached'],
      ['file watchers exhausted', 'EMFILE: too many open files'],
      ['out of memory or disk', 'ENOSPC: no space left on device'],
      ['lease or lock timeouts', 'Lease held after waiting 30000ms'],
      ['remote slot waits', 'remote-check: every check slot is busy; waiting for a free one'],
    ];
    const tasks = [
      { id: 'task-a', state: 'integrated' as const, currentAttempt: 2, brief: { goal: 'alpha' } },
      { id: 'task-b', state: 'integrated' as const, currentAttempt: 1, brief: { goal: 'beta' } },
    ] as unknown as Partial<Task>[];
    const attempts: Partial<Attempt>[] = [];
    for (const [index, [, error]] of kinds.entries())
      attempts.push(
        { taskId: 'task-a', attempt: index + 1, endedAt: minutesAgo(4), result: error },
        { taskId: 'task-a', attempt: index + 10, endedAt: minutesAgo(8), result: error },
        { taskId: 'task-b', attempt: index + 1, endedAt: minutesAgo(12), blocker: error },
      );
    const delivered: string[] = [];
    expect(
      watch(
        store(tasks, attempts),
        root,
        { stabilize: 'none', integration: 'none' },
        root,
        (message) => delivered.push(message),
        now,
      ),
    ).toBe(kinds.length);
    expect(delivered.map((message) => message.match(/^Incident: ([^:]+)/)?.[1])).toEqual(kinds.map(([name]) => name));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check hosts are probed once per five minutes and a repeated outage alerts again after recovery', () => {
  const root = temporaryDirectory('goal-watchdog-hosts-');
  try {
    writeFileSync(
      join(root, 'remote-check-hosts.json'),
      JSON.stringify({ hosts: [{ name: 'kernel-a', address: 'ops@kernel-a.test', identity: '/secret/identity' }] }),
    );
    const empty = store([], []);
    const delivered: string[] = [];
    const probes: string[] = [];
    let succeeds = false;
    const probe = (host: { name: string; address: string; identity: string }) => {
      probes.push(host.name);
      return succeeds
        ? { status: 0, stderr: '' }
        : { status: 255, stderr: 'ssh: Connection refused\n/private/key /secret/identity' };
    };
    const branches = { stabilize: 'none', integration: 'none' };
    const run = (at: number) => watch(empty, root, branches, root, (message) => delivered.push(message), at, probe);

    expect(run(now)).toBe(0);
    expect(run(now + 60_000)).toBe(0);
    expect(probes).toEqual(['kernel-a']);
    expect(run(now + 5 * 60_000)).toBe(1);
    expect(delivered).toEqual(['Incident: check host kernel-a refuses SSH: ssh: Connection refused']);
    expect(delivered[0]).not.toContain('/secret/identity');
    expect(run(now + 10 * 60_000)).toBe(0);
    expect(delivered).toHaveLength(1);

    succeeds = true;
    expect(run(now + 15 * 60_000)).toBe(0);
    succeeds = false;
    expect(run(now + 20 * 60_000)).toBe(0);
    expect(run(now + 25 * 60_000)).toBe(1);
    expect(delivered).toHaveLength(2);

    const probeCount = probes.length;
    rmSync(join(root, 'remote-check-hosts.json'));
    expect(run(now + 30 * 60_000)).toBe(0);
    expect(probes).toHaveLength(probeCount);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the recent-attempt store query excludes attempts outside the requested window', () => {
  const db = openDb(':memory:');
  try {
    migrate(db, workerMigrations.slice(0, 2));
    const rows = [
      ['recent', 1, '2026-10-26T11:45:00.000Z'],
      ['old', 1, '2026-10-26T11:29:59.999Z'],
      ['future', 1, '2026-10-26T12:00:00.001Z'],
    ] as const;
    for (const [sequence, [taskId, attempt, endedAt]] of rows.entries()) {
      db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
        taskId,
        sequence + 1,
        attempt,
        JSON.stringify({ id: taskId, currentAttempt: attempt }),
      );
      db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
        taskId,
        attempt,
        JSON.stringify({ taskId, attempt, endedAt, state: 'exited' }),
      );
    }
    const workerStore = new WorkerStore(db);
    const plan = db
      .query(
        "EXPLAIN QUERY PLAN SELECT body FROM worker_attempts WHERE json_extract(body, '$.endedAt') >= ? AND json_extract(body, '$.endedAt') <= ?",
      )
      .all('2026-10-26T11:30:00.000Z', '2026-10-26T12:00:00.000Z');
    expect(JSON.stringify(plan)).toContain('worker_attempts_ended_at');
    expect(
      workerStore.attemptsEndedBetween('2026-10-26T11:30:00.000Z', '2026-10-26T12:00:00.000Z').map((a) => a.taskId),
    ).toEqual(['recent']);
    workerStore.updateAttempt({ taskId: 'old', attempt: 1 }, (attempt) => {
      attempt.endedAt = '2026-10-26T11:30:00.000Z';
    });
    expect(
      workerStore.attemptsEndedBetween('2026-10-26T11:30:00.000Z', '2026-10-26T12:00:00.000Z').map((a) => a.taskId),
    ).toEqual(['old', 'recent']);
  } finally {
    db.close();
  }
});
