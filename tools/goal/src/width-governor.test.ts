import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { formatLifecycleMetrics } from './report.ts';
import { openDb } from './db.ts';
import { WIDTH_BUCKET_MS, sweepWidthGovernor, type WidthSnapshotOptions } from './width-governor.ts';
import { INBOX_DEDUPE_WINDOW_MS, SqliteManagerInbox } from './inbox.ts';
import { emitHourlyLifecycleMetrics, lifecycleMetrics, readHourlyLifecycleMetrics } from './lifecycle-metrics.ts';
import { processIdentity, type ProcessIdentity } from './process.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';
import { readControlPolicy } from './policy.ts';

const opened: { db: Database; closeDirectory(): void }[] = [];

afterEach(() => {
  const fixtures = opened.splice(0);
  for (const fixture of fixtures) fixture.db.close();
  for (const fixture of fixtures) fixture.closeDirectory();
});

function fixture() {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'goal.sqlite'));
  new WorkerStore(db);
  const clock = { now: Date.now() };
  const now = () => clock.now;
  const inbox = new SqliteManagerInbox(db, temporary.path, now);
  opened.push({ db, closeDirectory: temporary.close });
  return { db, inbox, now, clock, path: join(temporary.path, 'goal.sqlite'), directory: temporary.path };
}

function addTask(
  db: Database,
  id: string,
  sequence: number,
  state: string,
  currentAttempt: number,
  goal = 'goal-a',
  manager = goal,
): void {
  db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
    id,
    sequence,
    currentAttempt,
    JSON.stringify({
      id,
      sequence,
      currentAttempt,
      state,
      brief: { goal, manager, after: [] },
    }),
  );
}

function identity(pid: number, overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
  return { pid, start: `start-${pid}`, boot: 'test-boot', group: pid, ...overrides };
}

function addAttempt(
  db: Database,
  id: string,
  attempt: number,
  state: string,
  cli: string,
  process: ProcessIdentity | null,
): void {
  db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
    id,
    attempt,
    JSON.stringify({ taskId: id, attempt, state, profile: { cli }, process }),
  );
}

function addPendingStart(db: Database, id: string, attempt: number): void {
  db.query('INSERT INTO worker_retry_intents(task_id, attempt, body) VALUES (?, ?, ?)').run(
    id,
    attempt,
    JSON.stringify({ taskId: id, attempt, status: 'pending', options: {} }),
  );
}

function addManager(db: Database, id: string, status: string, goalStatus = 'active'): void {
  db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.query('INSERT INTO manager_sessions(id, state) VALUES (?, ?)').run(
    id,
    JSON.stringify({ id, status, goalState: { status: goalStatus } }),
  );
}

test('a low-width active Goal receives accurate, durable wakeable counts once per 15-minute bucket', async () => {
  const f = fixture();
  const live = new Set([1001, 1002, 1007]);
  addTask(f.db, 'codex-live', 1, 'running', 1);
  addAttempt(f.db, 'codex-live', 1, 'running', 'codex', identity(1001));
  addTask(f.db, 'claude-live', 2, 'running', 1);
  addAttempt(f.db, 'claude-live', 1, 'running', 'claude', identity(1002));
  addTask(f.db, 'held', 3, 'held', 1);
  addAttempt(f.db, 'held', 1, 'stopped', 'codex', identity(1003));
  addTask(f.db, 'stopped', 4, 'stopped', 1);
  addAttempt(f.db, 'stopped', 1, 'stopped', 'codex', identity(1004));
  addTask(f.db, 'ready-without-attempt', 5, 'ready', 0);
  addTask(f.db, 'ready-pending', 6, 'ready', 1);
  addAttempt(f.db, 'ready-pending', 1, 'pending', 'codex', null);
  addPendingStart(f.db, 'ready-pending', 1);
  addTask(f.db, 'waiting', 7, 'running', 1);
  addAttempt(f.db, 'waiting', 1, 'waiting', 'codex', identity(1007));
  addTask(f.db, 'stale-process', 8, 'running', 1);
  addAttempt(f.db, 'stale-process', 1, 'running', 'codex', identity(1008));

  const processIsLive = (process: ProcessIdentity) => live.has(process.pid);
  const at = Date.UTC(2026, 9, 31, 12, 0);
  const options: WidthSnapshotOptions = { processIsLive };
  const first = await sweepWidthGovernor(f.db, f.inbox, at, options);

  expect(first.deliveredGoals).toEqual(['goal-a']);
  expect(first.snapshot.goals[0]).toMatchObject({
    running: 2,
    codexRunning: 1,
    unknownRunning: 0,
    ready: 2,
    pendingStarts: 1,
    held: 1,
    stopped: 1,
    waiting: 1,
  });
  const pending = f.inbox.pending('goal-a');
  expect(pending).toHaveLength(1);
  expect(pending[0]?.event).toMatchObject({ managerId: 'goal-a', kind: 'width' });
  expect(pending[0]?.event.summary).toContain('2 confirmed live workers');
  expect(pending[0]?.event.summary).toContain('Codex subset 1 confirmed live');
  expect(pending[0]?.event.summary).toContain('ready 2, durable pending starts 1, held 1, stopped 1, waiting 1');
  expect(pending[0]?.event.summary).toContain('Recover, reshape, or dispatch real work');
  expect(pending[0]?.event.summary).toContain('Act on each stopped task within an hour');
  expect(pending[0]?.event.summary).not.toContain('do not restart stopped work');
  expect(pending[0]?.event.summary).toContain('Unsubmitted work is not observable');

  await sweepWidthGovernor(f.db, f.inbox, at + 5 * 60_000, options);
  expect(f.inbox.pending('goal-a')).toHaveLength(1);
  // The next bucket's identical text within the hour folds into the first row instead of waking the manager again.
  await sweepWidthGovernor(f.db, f.inbox, at + WIDTH_BUCKET_MS, options);
  expect(f.inbox.pending('goal-a')).toHaveLength(1);
  expect(f.inbox.pending('goal-a')[0]?.deliveries).toBe(2);
  f.clock.now += INBOX_DEDUPE_WINDOW_MS;
  await sweepWidthGovernor(f.db, f.inbox, at + 5 * WIDTH_BUCKET_MS, options);
  expect(f.inbox.pending('goal-a')).toHaveLength(2);
});

test('concurrent and restarted sweeps deduplicate a bucket; high width and protected managers receive no event', async () => {
  const f = fixture();
  const live = new Set<number>();
  for (let index = 0; index < 10; index++) {
    const id = `wide-${index}`;
    const pid = 2000 + index;
    live.add(pid);
    addTask(f.db, id, index + 1, 'running', 1, 'wide-goal');
    addAttempt(f.db, id, 1, 'running', 'codex', identity(pid));
  }
  addTask(f.db, 'wide-ready', 11, 'ready', 0, 'wide-goal');
  addTask(f.db, 'paused-held', 12, 'held', 0, 'paused-goal');
  addManager(f.db, 'paused-goal', 'paused');
  addTask(f.db, 'completed-ready', 13, 'ready', 0, 'completed-goal');
  addManager(f.db, 'completed-goal', 'complete');
  addTask(f.db, 'budget-limited-ready', 14, 'ready', 0, 'budget-goal');
  addManager(f.db, 'budget-goal', 'running', 'budgetLimited');

  const at = Date.UTC(2026, 9, 31, 13, 0);
  const options = { processIsLive: (process: ProcessIdentity) => live.has(process.pid) };
  const [first, second] = await Promise.all([
    sweepWidthGovernor(f.db, f.inbox, at, options),
    sweepWidthGovernor(f.db, f.inbox, at, options),
  ]);
  expect(first.snapshot.goals.find((goal) => goal.goal === 'wide-goal')?.running).toBe(10);
  expect(first.deliveredGoals).toEqual([]);
  expect(second.deliveredGoals).toEqual([]);
  expect(f.inbox.pending('wide-goal')).toHaveLength(0);
  expect(f.inbox.pending('paused-goal')).toHaveLength(0);
  expect(f.inbox.pending('completed-goal')).toHaveLength(0);
  expect(f.inbox.pending('budget-goal')).toHaveLength(0);

  const low = fixture();
  addTask(low.db, 'stopped-low', 1, 'stopped', 0, 'low-goal');
  const lowOptions = { processIsLive: () => false };
  const firstConcurrent = sweepWidthGovernor(low.db, low.inbox, at, lowOptions);
  const restartedDb = openDb(low.path);
  new WorkerStore(restartedDb);
  const restartedInbox = new SqliteManagerInbox(restartedDb, low.directory, low.now);
  opened.push({ db: restartedDb, closeDirectory() {} });
  const secondConcurrent = sweepWidthGovernor(restartedDb, restartedInbox, at, lowOptions);
  await Promise.all([firstConcurrent, secondConcurrent]);
  expect(low.inbox.pending('low-goal')).toHaveLength(1);
  await sweepWidthGovernor(restartedDb, restartedInbox, at + 60_000, lowOptions);
  expect(low.inbox.pending('low-goal')).toHaveLength(1);
  low.clock.now += INBOX_DEDUPE_WINDOW_MS;
  await sweepWidthGovernor(restartedDb, restartedInbox, at + WIDTH_BUCKET_MS, lowOptions);
  expect(low.inbox.pending('low-goal')).toHaveLength(2);
});

test('hourly lifecycle and flow report expose live system and Codex counts with unknown evidence', () => {
  const f = fixture();
  const current = processIdentity();
  expect(current).not.toBeNull();
  addTask(f.db, 'live-codex', 1, 'running', 1);
  addAttempt(f.db, 'live-codex', 1, 'running', 'codex', current!);
  addTask(f.db, 'stale-codex', 2, 'running', 1);
  addAttempt(f.db, 'stale-codex', 1, 'running', 'codex', { ...current!, start: `${current!.start}-stale` });
  addTask(f.db, 'unknown-codex', 3, 'running', 1);
  addAttempt(f.db, 'unknown-codex', 1, 'running', 'codex', null);

  const at = Date.UTC(2026, 9, 31, 14, 0);
  const metrics = lifecycleMetrics(f.db, at);
  expect(metrics.width.system).toMatchObject({
    running: 1,
    codexRunning: 1,
    unknownRunning: 1,
    unknownCodexRunning: 1,
  });
  const lines = formatLifecycleMetrics(metrics);
  expect(lines).toContain(
    'Actual system-wide running workers: 1 confirmed live; 1 current running attempts have unknown process identity.',
  );
  expect(lines).toContain(
    'Actual Codex running workers: 1 confirmed live; 1 have unknown process identity; 0 have unknown CLI evidence.',
  );

  expect(emitHourlyLifecycleMetrics(f.db, metrics, at)).toBe(true);
  const saved = readHourlyLifecycleMetrics(f.db, at);
  expect(saved?.metrics.width.system).toMatchObject({ running: 1, codexRunning: 1, unknownRunning: 1 });
});

test('width policy overrides preserve paged counts, threshold boundaries and bucket deduplication', async () => {
  const f = fixture();
  addTask(f.db, 'live', 1, 'running', 1);
  addAttempt(f.db, 'live', 1, 'running', 'codex', identity(123));
  addTask(f.db, 'ready', 2, 'ready', 0);
  const low = readControlPolicy({ width: { workerThreshold: 1, pageSize: 1, bucketMs: 100, sweepYieldItems: 1 } });
  const high = readControlPolicy({
    width: { ...low.width, workerThreshold: 2 },
    backlog: { lowWater: 3, stoppedTaskLimitMs: 120000 },
  });
  const delivered: string[] = [];
  const inbox = { deliver: (event: { summary: string }) => delivered.push(event.summary) } as unknown as Parameters<
    typeof sweepWidthGovernor
  >[1];
  const run = (at: number, policy = high) => sweepWidthGovernor(f.db, inbox, at, { policy, processIsLive: () => true });
  expect((await run(100, low)).deliveredGoals).toEqual([]);
  const first = await run(100);
  expect(first.snapshot.system).toMatchObject({ running: 1, codexRunning: 1, ready: 1 });
  expect(first.deliveredGoals).toEqual(['goal-a']);
  expect((await run(199)).deliveredGoals).toEqual([]);
  expect((await run(200)).deliveredGoals).toEqual(['goal-a']);
  expect(delivered[0]).toContain('within 2 minutes');
  expect(delivered[0]).toContain('at least 3 ready briefs');
});
