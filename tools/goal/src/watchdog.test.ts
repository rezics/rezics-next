import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrate, openDb } from './db.ts';
import { sshProbe, violations, watch } from './watchdog.ts';
import { processIdentity } from './process.ts';
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

test('a pending retry held for dependencies or a backoff is waiting by design, not missing its starter', () => {
  const tasks = [
    { id: 'held', state: 'ready' as const, currentAttempt: 1, brief: { goal: 'web', after: ['producer'] } },
    { id: 'backoff', state: 'ready' as const, currentAttempt: 1, brief: { goal: 'web', after: [] } },
    { id: 'lost', state: 'ready' as const, currentAttempt: 1, brief: { goal: 'web', after: ['done'] } },
  ] as Partial<Task>[];
  const attempts = tasks.map((task) => ({
    taskId: task.id!,
    attempt: 1,
    state: 'exited' as const,
    endedAt: minutesAgo(393),
  }));
  const intents = [
    { taskId: 'held', attempt: 1, status: 'pending' as const, options: {} },
    {
      taskId: 'backoff',
      attempt: 1,
      status: 'pending' as const,
      options: { notBefore: new Date(now + 60_000).toISOString() },
    },
    { taskId: 'lost', attempt: 1, status: 'pending' as const, options: {} },
  ];
  const states: Record<string, string> = { producer: 'running', done: 'integrated' };
  const found = violations({ ...store(tasks, attempts, intents), dependency: (id) => ({ state: states[id]! }) }, now);
  expect(found.map((violation) => violation.key)).toEqual(['no-worker:lost:1']);
});

test('an exited attempt with a live driver is not reported while its driver settles it', () => {
  const driver = processIdentity();
  expect(driver).not.toBeNull();
  const tasks = [
    { id: 'settling', state: 'running' as const, currentAttempt: 1 },
    { id: 'orphan', state: 'running' as const, currentAttempt: 2 },
  ];
  const attempts = [
    {
      taskId: 'settling',
      attempt: 1,
      state: 'exited' as const,
      endedAt: minutesAgo(30),
      driver: driver!,
    },
    {
      taskId: 'orphan',
      attempt: 2,
      state: 'exited' as const,
      endedAt: minutesAgo(30),
      driver: { ...driver!, pid: 0 },
    },
  ];

  expect(violations(store(tasks, attempts), now).map((violation) => violation.key)).toEqual(['no-worker:orphan:2']);
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
        failureKind: 'tool',
        result: 'SSH exit 255: host refused the connection',
      },
      {
        taskId: 'accounts-1',
        attempt: 2,
        state: 'exited',
        endedAt: minutesAgo(8),
        failureKind: 'tool',
        result: 'SSH exit 255: host refused the connection',
      },
      {
        taskId: 'billing-1',
        attempt: 1,
        state: 'exited',
        endedAt: minutesAgo(27),
        result: JSON.stringify({ status: 'blocked', summary: 'needs intervention' }),
        blocker: 'SSH exit 255: host refused the connection',
      },
      {
        taskId: 'billing-1',
        attempt: 2,
        state: 'exited',
        endedAt: minutesAgo(31),
        failureKind: 'tool',
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
        { taskId: 'task-a', attempt: index + 1, endedAt: minutesAgo(4), failureKind: 'tool', result: error },
        { taskId: 'task-a', attempt: index + 10, endedAt: minutesAgo(8), failureKind: 'tool', result: error },
        { taskId: 'task-b', attempt: index + 1, endedAt: minutesAgo(12), failureKind: 'tool', blocker: error },
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

test('a successful attempt whose summary mentions a lease, a slot wait or a connection error never counts toward an incident', () => {
  const root = temporaryDirectory('goal-watchdog-success-signatures-');
  try {
    const tasks = [
      { id: 'task-a', brief: { goal: 'alpha' } },
      { id: 'task-b', brief: { goal: 'beta' } },
    ] as unknown as Partial<Task>[];
    const summaries = [
      'Lease held after waiting 30000ms',
      'remote-check: every check slot is busy; waiting for a free one',
      'SSH exit 255: host refused the connection',
    ];
    const attempts: Partial<Attempt>[] = summaries.flatMap((summary, index) => {
      const result = JSON.stringify({ status: 'success', summary });
      return [
        {
          taskId: 'task-a',
          attempt: index + 1,
          state: 'exited',
          endedAt: minutesAgo(4),
          failureKind: null,
          result,
        },
        {
          taskId: 'task-a',
          attempt: index + 10,
          state: 'exited',
          endedAt: minutesAgo(8),
          failureKind: null,
          result,
        },
        {
          taskId: 'task-b',
          attempt: index + 1,
          state: 'exited',
          endedAt: minutesAgo(12),
          failureKind: null,
          result,
        },
      ];
    });
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
    ).toBe(0);
    expect(delivered).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the check-host probe starts its SSH attempts in the background and never blocks the sweep', () => {
  const root = temporaryDirectory('goal-watchdog-background-hosts-');
  const host = { name: 'kernel-a', address: 'ops@kernel-a.test', identity: '/secret/identity' };
  try {
    const calls: { command: string; args: string[]; options: { detached?: boolean; stdio?: unknown } }[] = [];
    const child = new EventEmitter() as EventEmitter & { stderr: PassThrough; unref: () => void };
    child.stderr = new PassThrough();
    let unrefed = false;
    child.unref = () => {
      unrefed = true;
    };
    const fakeSpawn = ((command: string, args: string[], options: { detached?: boolean; stdio?: unknown }) => {
      calls.push({ command, args, options });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const received: { status: number | null; stderr: string }[] = [];

    sshProbe(host, (result) => received.push(result), fakeSpawn);
    expect(calls).toEqual([
      {
        command: 'ssh',
        args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', host.identity, host.address, 'true'],
        options: { detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
      },
    ]);
    expect(unrefed).toBe(true);
    expect(received).toEqual([]);

    writeFileSync(join(root, 'remote-check-hosts.json'), JSON.stringify({ hosts: [host] }));
    const empty = store([], []);
    const branches = { stabilize: 'none', integration: 'none' };
    let finishProbe: ((result: { status: number | null; stderr: string }) => void) | undefined;
    const launched: string[] = [];
    const started = Date.now();
    expect(
      watch(
        empty,
        root,
        branches,
        root,
        () => {},
        now,
        (probeHost, complete) => {
          launched.push(probeHost.name);
          finishProbe = complete;
        },
      ),
    ).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(launched).toEqual(['kernel-a']);
    expect(finishProbe).toBeDefined();
    expect(existsSync(join(root, 'host-probes', 'kernel-a.json'))).toBe(false);

    child.stderr.write('ssh: Connection refused\n/private/key /secret/identity');
    child.emit('close', 255, null);
    expect(received).toEqual([{ status: 255, stderr: 'ssh: Connection refused' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an SSH probe that connects but never finishes produces one bounded failure and retains only a bounded first diagnostic line', async () => {
  const host = { name: 'kernel-a', address: 'ops@kernel-a.test', identity: '/secret/identity' };
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough;
    unref: () => void;
    kill: () => boolean;
  };
  child.stderr = new PassThrough();
  child.unref = () => {};
  let killed = 0;
  child.kill = () => {
    killed += 1;
    return true;
  };
  const fakeSpawn = (() => child) as unknown as typeof import('node:child_process').spawn;
  const received: { status: number | null; stderr: string }[] = [];
  const finished = new Promise<void>((resolve) => {
    sshProbe(
      host,
      (result) => {
        received.push(result);
        resolve();
      },
      fakeSpawn,
      1,
    );
  });
  const diagnostic = `ssh: ${'x'.repeat(20_000)}`;
  child.stderr.write(diagnostic);
  await finished;
  expect(received).toEqual([{ status: null, stderr: diagnostic.slice(0, 4 * 1024) }]);
  expect(killed).toBe(1);
  child.stderr.write('still-open-without-newline');
  child.emit('close', 0, null);
  child.emit('error', new Error('late failure'));
  expect(received).toHaveLength(1);
  expect(killed).toBe(1);
});

test('a sweep judges the probe results the previous sweep started, and two failures in a row report the host once', () => {
  const root = temporaryDirectory('goal-watchdog-previous-hosts-');
  try {
    writeFileSync(
      join(root, 'remote-check-hosts.json'),
      JSON.stringify({ hosts: [{ name: 'kernel-a', address: 'ops@kernel-a.test', identity: '/secret/identity' }] }),
    );
    const empty = store([], []);
    const delivered: string[] = [];
    const completions: ((result: { status: number | null; stderr: string }) => void)[] = [];
    const probe = (
      _host: { name: string; address: string; identity: string },
      complete: (result: { status: number | null; stderr: string }) => void,
    ) => {
      completions.push(complete);
    };
    const branches = { stabilize: 'none', integration: 'none' };
    const run = (at: number) => watch(empty, root, branches, root, (message) => delivered.push(message), at, probe);
    const failure = { status: 255, stderr: 'ssh: Connection refused\n/private/key /secret/identity' };

    expect(run(now)).toBe(0);
    expect(completions).toHaveLength(1);
    expect(existsSync(join(root, 'host-probes', 'kernel-a.json'))).toBe(false);

    // This job is still running at the next due sweep, so it is no result. A late completion is stale.
    expect(run(now + 5 * 60_000)).toBe(0);
    expect(completions).toHaveLength(2);
    completions[0]!(failure);
    completions[1]!(failure);

    // The sweep consumes only the result from the sweep at +5 minutes: failure one.
    expect(run(now + 10 * 60_000)).toBe(0);
    expect(completions).toHaveLength(3);
    completions[2]!(failure);

    // The next due sweep sees the second consecutive failed result and reports exactly once.
    expect(run(now + 15 * 60_000)).toBe(1);
    expect(delivered).toEqual(['Incident: check host kernel-a refuses SSH: ssh: Connection refused']);
    expect(delivered[0]).not.toContain('/secret/identity');
    expect(run(now + 20 * 60_000)).toBe(0);
    expect(delivered).toHaveLength(1);
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
    const probe = (
      host: { name: string; address: string; identity: string },
      complete: (result: { status: number | null; stderr: string }) => void,
    ) => {
      probes.push(host.name);
      complete(
        succeeds
          ? { status: 0, stderr: '' }
          : { status: 255, stderr: 'ssh: Connection refused\n/private/key /secret/identity' },
      );
    };
    const branches = { stabilize: 'none', integration: 'none' };
    const run = (at: number) => watch(empty, root, branches, root, (message) => delivered.push(message), at, probe);

    expect(run(now)).toBe(0);
    expect(run(now + 60_000)).toBe(0);
    expect(probes).toEqual(['kernel-a']);
    expect(run(now + 5 * 60_000)).toBe(0);
    expect(run(now + 10 * 60_000)).toBe(1);
    expect(delivered).toEqual(['Incident: check host kernel-a refuses SSH: ssh: Connection refused']);
    expect(delivered[0]).not.toContain('/secret/identity');
    expect(run(now + 15 * 60_000)).toBe(0);
    expect(delivered).toHaveLength(1);

    succeeds = true;
    expect(run(now + 20 * 60_000)).toBe(0);
    succeeds = false;
    expect(run(now + 25 * 60_000)).toBe(0);
    expect(run(now + 30 * 60_000)).toBe(0);
    expect(run(now + 35 * 60_000)).toBe(1);
    expect(delivered).toHaveLength(2);

    const probeCount = probes.length;
    rmSync(join(root, 'remote-check-hosts.json'));
    expect(run(now + 40 * 60_000)).toBe(0);
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

test('a long attempt whose last command spans lines is reported once, on one line', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-watchdog-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  try {
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
    git('branch', 'dev');
    git('branch', 'stabilize');
    const log = join(root, 'attempt.jsonl');
    writeFileSync(
      log,
      `${JSON.stringify({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: "zsh -lc 'set -e\nbun test'" } })}\n`,
    );
    const tasks = store(
      [
        {
          id: 'long',
          state: 'running' as const,
          currentAttempt: 1,
          brief: { goal: 'web', manager: 'web' } as Task['brief'],
        },
      ],
      [{ taskId: 'long', attempt: 1, state: 'running', startedAt: minutesAgo(200), logPath: log } as Partial<Attempt>],
    );
    const delivered: string[] = [];
    const deliver = (summary: string) => {
      if (/[\r\n]/.test(summary)) throw new Error('Manager event summary must be one line');
      delivered.push(summary);
    };
    const branches = { stabilize: 'stabilize', integration: 'dev' };
    watch(
      tasks,
      root,
      branches,
      root,
      deliver,
      now,
      async () => [],
      () => 60_000,
    );
    watch(
      tasks,
      root,
      branches,
      root,
      deliver,
      now + 60_000,
      async () => [],
      () => 60_000,
    );
    const longAttempts = delivered.filter((summary) => summary.startsWith('Long attempt:'));
    expect(longAttempts).toHaveLength(1);
    expect(longAttempts[0]).toContain("zsh -lc 'set -e bun test'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a waiting attempt older than its class limit is reported as a long attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-watchdog-waiting-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
  try {
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
    git('branch', 'dev');
    git('branch', 'stabilize');
    const tasks = store(
      [
        {
          id: 'waiting',
          state: 'running' as const,
          currentAttempt: 1,
          brief: { goal: 'web', manager: 'web' } as Task['brief'],
        },
      ],
      [
        {
          taskId: 'waiting',
          attempt: 1,
          state: 'waiting',
          startedAt: minutesAgo(200),
          logPath: join(root, 'attempt.jsonl'),
        } as Partial<Attempt>,
      ],
    );
    const delivered: string[] = [];
    watch(
      tasks,
      root,
      { stabilize: 'stabilize', integration: 'dev' },
      root,
      (summary) => delivered.push(summary),
      now,
      async () => [],
      () => 60_000,
    );
    expect(delivered.filter((summary) => summary.startsWith('Long attempt:'))).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
