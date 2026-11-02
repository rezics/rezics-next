import { afterEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  BACKLOG_WAKE_INTERVAL_MS,
  STOPPED_TASK_LIMIT_MS,
  STOPPED_TASKS_PER_GOAL_PER_RUN,
  backlogStatus,
  formatBacklogStatus,
  sweepBacklog,
  type BacklogRuntime,
} from './backlog.ts';
import { openDb } from './db.ts';
import { createRuntime } from './config.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { runIntegration } from './integration-cli.ts';
import { acquireDirectoryLease } from './lease.ts';
import { WorkerStore } from './store.ts';
import { brief as fixtureBrief, harness, markdown, temporaryDirectory } from './test-support.ts';

const NOW = Date.UTC(2026, 10, 2, 12, 0);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(options: { workerCap?: number; perSweep?: number; refuse?: RegExp } = {}) {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'goal.sqlite'));
  new WorkerStore(db);
  const inbox = new SqliteManagerInbox(db, temporary.path, () => clock.now);
  const clock = { now: NOW };
  const dispatched: { file: string; text: string }[] = [];
  const continued: { goal: string; taskId: string; attempt: number; file: string }[] = [];
  const cancelled: string[] = [];
  const runtime: BacklogRuntime = {
    db,
    stateDirectory: temporary.path,
    inbox,
    now: () => clock.now,
    workerCap: options.workerCap ?? 32,
    ...(options.perSweep ? { perSweep: options.perSweep } : {}),
    async dispatch(file) {
      const text = readFileSync(file, 'utf8');
      if (options.refuse?.test(text)) throw new Error(`brief refused: ${text.trim()}\nsecond line`);
      dispatched.push({ file, text });
      return `task-${dispatched.length}`;
    },
    async continueTask(goal, continuation, file) {
      continued.push({ goal, taskId: continuation.taskId, attempt: continuation.expectedAttempt, file });
    },
    async cancel(taskId) {
      cancelled.push(taskId);
      const row = db.query('SELECT body FROM worker_tasks WHERE id=?').get(taskId) as { body: string };
      db.query('UPDATE worker_tasks SET body=? WHERE id=?').run(
        JSON.stringify({ ...JSON.parse(row.body), state: 'cancelled' }),
        taskId,
      );
    },
  };
  cleanups.push(() => {
    db.close();
    temporary.close();
  });
  return { db, inbox, runtime, clock, dispatched, continued, cancelled, state: temporary.path };
}

function existingTask(
  h: ReturnType<typeof harness>,
  id: string,
  state: string,
  goal = 'fixture',
  attemptState = 'exited',
) {
  const source = fixtureBrief();
  const created = h.store.createTask(
    { ...source, goal },
    { briefPath: h.briefFile, worktree: h.root, branch: `worker/${id}`, base: 'main' },
    'implementation',
    id,
  );
  h.store.db
    .query('UPDATE worker_tasks SET current_attempt=1, body=? WHERE id=?')
    .run(JSON.stringify({ ...created, currentAttempt: 1, state }), id);
  h.store.db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, 1, ?)').run(
    id,
    JSON.stringify({
      state: attemptState,
      session: `paid-${id}`,
      process: null,
      driver: null,
      auxiliaryProcesses: [],
    }),
  );
  return created;
}

function continuationBrief(taskId: string, expectedAttempt: number, goal = 'fixture'): string {
  return markdown
    .replace(
      'goal: fixture',
      `goal: ${goal}\nmanager: fixture\ncontinuation:\n  taskId: ${taskId}\n  expectedAttempt: ${expectedAttempt}`,
    )
    .replace('Write the requested result and commit it.', `Continue ${taskId} and keep its existing work.`);
}

function brief(state: string, goal: string, name: string, ageMs: number, text = `${goal}/${name}`): string {
  const directory = join(state, 'backlog', goal);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, `${text}\n`);
  const at = (NOW - ageMs) / 1000;
  utimesSync(file, at, at);
  return file;
}

function task(db: Database, id: string, state: string, brief: Record<string, unknown>, sequence: number): void {
  db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
    id,
    sequence,
    1,
    JSON.stringify({
      id,
      state,
      branch: `worker/${id}`,
      createdAt: new Date(NOW - 5 * 3_600_000).toISOString(),
      brief,
    }),
  );
}

function event(db: Database, id: string, kind: string, at: number, body: unknown = {}): void {
  db.query('INSERT INTO worker_events(task_id, attempt, kind, at, body) VALUES (?, 1, ?, ?, ?)').run(
    id,
    kind,
    new Date(at).toISOString(),
    JSON.stringify(body),
  );
}

function manager(db: Database, id: string, state: Record<string, unknown>): void {
  db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.query('INSERT INTO manager_sessions(id, state) VALUES (?, ?)').run(id, JSON.stringify({ id, ...state }));
}

test('ready briefs dispatch oldest first, round-robin across Goals, only up to the active-task cap', async () => {
  const f = fixture({ workerCap: 5 });
  task(f.db, 'busy', 'running', { goal: 'web', manager: 'web' }, 1);
  task(f.db, 'queued', 'ready', { goal: 'web', manager: 'web' }, 2);
  brief(f.state, 'web', 'b-newer.md', 60_000);
  brief(f.state, 'web', 'a-older.md', 120_000);
  brief(f.state, 'web', 'c-newest.md', 30_000);
  brief(f.state, 'search', 'only.md', 10 * 60_000, '---\nkind: research\n---\nResearch brief');
  brief(f.state, 'search', 'unsettled.md', 1_000);
  writeFileSync(join(f.state, 'backlog', 'web', 'notes.txt'), 'not a brief');

  const sweep = await sweepBacklog(f.runtime);

  // Five slots, two taken: three dispatches, alternating Goals, oldest brief of each Goal first.
  expect(sweep.dispatched.map((entry) => `${entry.goal}/${entry.brief}`)).toEqual([
    'search/only.md',
    'web/a-older.md',
    'web/b-newer.md',
  ]);
  expect(f.dispatched[0]!.text).toContain('kind: research');
  expect(readdirSync(join(f.state, 'backlog', 'search', 'dispatched'))).toEqual(['task-1-only.md']);
  expect(readdirSync(join(f.state, 'backlog', 'web', 'dispatched')).sort()).toEqual([
    'task-2-a-older.md',
    'task-3-b-newer.md',
  ]);
  // A brief changed in the last seconds may still be being written; it waits for the next sweep.
  expect(existsSync(join(f.state, 'backlog', 'search', 'unsettled.md'))).toBe(true);
  expect(existsSync(join(f.state, 'backlog', 'web', 'c-newest.md'))).toBe(true);
  expect(existsSync(join(f.state, 'backlog', 'web', '.dispatching', 'a-older.md'))).toBe(false);

  expect(backlogStatus(f.state)).toEqual([
    { goal: 'search', ready: 1, dispatched: 1, failed: 0 },
    { goal: 'web', ready: 1, dispatched: 2, failed: 0 },
  ]);
  expect(formatBacklogStatus(backlogStatus(f.state)).split('\n')[0]).toMatch(/^goal\s+ready\s+dispatched\s+failed$/);
});

test('the Goal served longest ago goes first, and a full cap dispatches nothing', async () => {
  const f = fixture({ workerCap: 32, perSweep: 1 });
  brief(f.state, 'alpha', 'one.md', 60_000);
  brief(f.state, 'alpha', 'two.md', 50_000);
  brief(f.state, 'beta', 'one.md', 40_000);
  expect((await sweepBacklog(f.runtime)).dispatched.map((entry) => entry.goal)).toEqual(['alpha']);
  f.clock.now += 1;
  expect((await sweepBacklog(f.runtime)).dispatched.map((entry) => entry.goal)).toEqual(['beta']);
  f.clock.now += 1;
  expect((await sweepBacklog(f.runtime)).dispatched.map((entry) => entry.goal)).toEqual(['alpha']);

  const full = fixture({ workerCap: 1 });
  task(full.db, 'busy', 'running', { goal: 'web', manager: 'web' }, 1);
  brief(full.state, 'web', 'waits.md', 60_000);
  expect((await sweepBacklog(full.runtime)).dispatched).toEqual([]);
  expect(existsSync(join(full.state, 'backlog', 'web', 'waits.md'))).toBe(true);
});

test('a refused brief moves to failed with its reason, and the owner gets one event per sweep', async () => {
  const f = fixture({ refuse: /REFUSE/ });
  brief(f.state, 'web', 'bad-one.md', 90_000, 'REFUSE one');
  brief(f.state, 'web', 'bad-two.md', 80_000, 'REFUSE two');
  brief(f.state, 'web', 'good.md', 70_000);

  const sweep = await sweepBacklog(f.runtime);

  expect(sweep.dispatched.map((entry) => entry.brief)).toEqual(['good.md']);
  expect(sweep.refused.map((entry) => entry.brief)).toEqual(['bad-one.md', 'bad-two.md']);
  const failed = join(f.state, 'backlog', 'web', 'failed');
  expect(readdirSync(failed).sort()).toEqual(['bad-one.md', 'bad-one.reason', 'bad-two.md', 'bad-two.reason']);
  expect(readFileSync(join(failed, 'bad-one.reason'), 'utf8')).toContain('brief refused: REFUSE one');
  const events = f.inbox.pending('web');
  expect(events).toHaveLength(1);
  expect(events[0]!.event.kind).toBe('instruction');
  expect(events[0]!.event.summary).toContain('Backlog dispatch refused 2 brief(s): bad-one.md');
  expect(events[0]!.event.summary).toContain(failed);
});

test('refused revisions with the same filename keep separate briefs and reasons', async () => {
  const f = fixture({ refuse: /REFUSE/ });
  brief(f.state, 'web', 'same.md', 90_000, 'REFUSE first revision');
  await sweepBacklog(f.runtime);
  brief(f.state, 'web', 'same.md', 80_000, 'REFUSE second revision');

  const sweep = await sweepBacklog(f.runtime);
  const failed = join(f.state, 'backlog', 'web', 'failed');

  expect(sweep.refused.map((entry) => entry.brief)).toEqual(['same-2.md']);
  expect(readdirSync(failed).sort()).toEqual(['same-2.md', 'same-2.reason', 'same.md', 'same.reason']);
  expect(readFileSync(join(failed, 'same.md'), 'utf8')).toContain('REFUSE first revision');
  expect(readFileSync(join(failed, 'same.reason'), 'utf8')).toContain('REFUSE first revision');
  expect(readFileSync(join(failed, 'same-2.md'), 'utf8')).toContain('REFUSE second revision');
  expect(readFileSync(join(failed, 'same-2.reason'), 'utf8')).toContain('REFUSE second revision');
  const events = f.inbox.pending('web');
  expect(events[events.length - 1]!.event.summary).toContain('same-2.md');
});

test('a refused brief resumes its reason-first archive after interruption', async () => {
  const f = fixture({ refuse: /REFUSE/ });
  brief(f.state, 'web', 'interrupted.md', 90_000, 'REFUSE interrupted');
  await sweepBacklog(f.runtime);

  const goalDirectory = join(f.state, 'backlog', 'web');
  const failed = join(goalDirectory, 'failed');
  const claim = join(goalDirectory, '.dispatching', 'interrupted.md');
  mkdirSync(join(goalDirectory, '.dispatching'), { recursive: true });
  renameSync(join(failed, 'interrupted.md'), claim);

  const sweep = await sweepBacklog(f.runtime);

  expect(sweep.refused.map((entry) => entry.brief)).toEqual(['interrupted.md']);
  expect(readdirSync(failed).sort()).toEqual(['interrupted.md', 'interrupted.reason']);
  expect(readFileSync(join(failed, 'interrupted.reason'), 'utf8')).toContain('REFUSE interrupted');
});

test('an uncommitted interrupted claim returns to the ready backlog and dispatches once', async () => {
  const f = fixture();
  const claims = join(f.state, 'backlog', 'web', '.dispatching');
  mkdirSync(claims, { recursive: true });
  const file = join(claims, 'interrupted.md');
  writeFileSync(file, 'Interrupted brief\n');
  utimesSync(file, (NOW - 60_000) / 1000, (NOW - 60_000) / 1000);

  const sweep = await sweepBacklog(f.runtime);

  expect(f.dispatched.map((entry) => entry.text)).toEqual(['Interrupted brief\n']);
  expect(sweep.dispatched).toEqual([{ goal: 'web', taskId: 'task-1', brief: 'interrupted.md' }]);
  expect(sweep.refused).toEqual([]);
  expect(readdirSync(join(f.state, 'backlog', 'web', 'dispatched'))).toEqual(['task-1-interrupted.md']);
  expect(existsSync(join(f.state, 'backlog', 'web', 'failed', 'interrupted.md'))).toBe(false);
});

test('an interrupted claim whose dispatch already committed archives onto the existing task once', async () => {
  const f = fixture();
  const text = 'Committed brief\n';
  const id = 'existing-task';
  task(f.db, id, 'ready', { goal: 'web', manager: 'web', markdown: text }, 1);
  task(f.db, 'older', 'integrated', { goal: 'web', manager: 'web', markdown: text }, 2);
  task(f.db, 'other-goal', 'ready', { goal: 'search', manager: 'search', markdown: text }, 3);
  mkdirSync(join(f.state, 'backlog', 'web', 'dispatched'), { recursive: true });
  writeFileSync(join(f.state, 'backlog', 'web', 'dispatched', 'older-prior.md'), text);
  const claims = join(f.state, 'backlog', 'web', '.dispatching');
  mkdirSync(claims, { recursive: true });
  writeFileSync(join(claims, 'work.md'), text);

  const sweep = await sweepBacklog(f.runtime);

  expect(f.dispatched).toEqual([]);
  expect(sweep.dispatched).toEqual([{ goal: 'web', taskId: id, brief: 'work.md' }]);
  expect(readdirSync(join(f.state, 'backlog', 'web', 'dispatched')).sort()).toEqual([
    `${id}-work.md`,
    'older-prior.md',
  ]);
  expect(readFileSync(join(f.state, 'backlog', 'web', 'dispatched', `${id}-work.md`), 'utf8')).toBe(text);
  expect((await sweepBacklog(f.runtime)).dispatched).toEqual([]);
  expect(f.dispatched).toEqual([]);
});

test('an interrupted claim that matches several unarchived tasks is refused with those ids', async () => {
  const f = fixture();
  const text = 'Shared brief\n';
  task(f.db, 'task-a', 'ready', { goal: 'web', manager: 'web', markdown: text }, 1);
  task(f.db, 'task-b', 'ready', { goal: 'web', manager: 'web', markdown: text }, 2);
  const claims = join(f.state, 'backlog', 'web', '.dispatching');
  mkdirSync(claims, { recursive: true });
  writeFileSync(join(claims, 'shared.md'), text);

  const sweep = await sweepBacklog(f.runtime);

  expect(f.dispatched).toEqual([]);
  expect(sweep.refused.map((entry) => entry.brief)).toEqual(['shared.md']);
  expect(sweep.refused[0]!.reason).toContain('task-a');
  expect(sweep.refused[0]!.reason).toContain('task-b');
  expect(existsSync(join(f.state, 'backlog', 'web', 'failed', 'shared.md'))).toBe(true);
  expect(f.inbox.pending('web')).toHaveLength(1);
});

test('the controller resumes an exact owner task once and refuses stale, foreign, cancelled and live targets', async () => {
  const h = harness();
  cleanups.push(() => h.dispose());
  const original = existingTask(h, 'retained', 'stopped');
  h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  h.store.db
    .query('INSERT INTO manager_sessions(id, state) VALUES (?, ?)')
    .run(
      'fixture',
      JSON.stringify({ id: 'fixture', kind: 'managed', engine: 'codex', status: 'running', threadId: 'owner-session' }),
    );

  const directory = join(h.settings.stateDirectory, 'backlog', 'fixture');
  const claimed = join(directory, '.dispatching', 'resume.md');
  mkdirSync(join(directory, '.dispatching'), { recursive: true });
  writeFileSync(claimed, continuationBrief(original.id, 1));
  utimesSync(claimed, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
  const runtime = createRuntime({ settings: h.settings, db: h.store.db });
  const dispatch = async () => {
    const lines: string[] = [];
    const log = console.log;
    const taskId = process.env.GOAL_TASK_ID;
    const attempt = process.env.GOAL_ATTEMPT;
    delete process.env.GOAL_TASK_ID;
    delete process.env.GOAL_ATTEMPT;
    console.log = (line?: unknown) => lines.push(String(line));
    try {
      await runIntegration(['backlog', 'dispatch'], runtime);
    } finally {
      console.log = log;
      if (taskId === undefined) delete process.env.GOAL_TASK_ID;
      else process.env.GOAL_TASK_ID = taskId;
      if (attempt === undefined) delete process.env.GOAL_ATTEMPT;
      else process.env.GOAL_ATTEMPT = attempt;
    }
    return JSON.parse(lines[0]!);
  };

  const first = await dispatch();
  expect(first.continued).toEqual([{ goal: 'fixture', taskId: original.id, attempt: 1, brief: 'resume.md' }]);
  expect(first.dispatched).toEqual([]);
  const archived = join(directory, 'continued', 'retained-1-resume.md');
  expect(existsSync(archived)).toBe(true);
  rmSync(archived);
  writeFileSync(claimed, continuationBrief(original.id, 1));
  utimesSync(claimed, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));

  const second = await dispatch();
  expect(second.continued).toHaveLength(1);
  expect(h.store.taskIds()).toEqual([original.id]);
  expect(h.store.db.query('SELECT count(*) AS n FROM worker_retry_intents').get()).toEqual({ n: 1 });
  const resumed = JSON.parse(
    (h.store.db.query('SELECT body FROM worker_tasks WHERE id=?').get(original.id) as { body: string }).body,
  );
  expect(resumed.branch).toBe(original.branch);
  expect(resumed.worktree).toBe(original.worktree);
  expect(
    h.store.db
      .query("SELECT json_extract(body, '$.session') AS session FROM worker_attempts WHERE task_id=? AND attempt=1")
      .get(original.id),
  ).toEqual({ session: 'paid-retained' });

  const refusals = [
    ['stale', 'stopped', 'fixture', 'exited', 2],
    ['foreign', 'stopped', 'other', 'exited', 1],
    ['cancelled', 'cancelled', 'fixture', 'exited', 1],
    ['live', 'running', 'fixture', 'running', 1],
  ] as const;
  for (const [id, state, goal, attemptState, expected] of refusals) {
    existingTask(h, id, state, goal, attemptState);
    const file = join(directory, `${id}.md`);
    writeFileSync(file, continuationBrief(id, expected));
    utimesSync(file, new Date(Date.now() - 20_000), new Date(Date.now() - 20_000));
  }
  const third = await dispatch();
  const reasons = new Map(third.refused.map((entry: { brief: string; reason: string }) => [entry.brief, entry.reason]));
  expect(reasons.get('stale.md')).toContain('is stale');
  expect(reasons.get('foreign.md')).toContain('belongs to Goal other');
  expect(reasons.get('cancelled.md')).toContain('is cancelled');
  expect(reasons.get('live.md')).toContain('already live');
  expect(h.store.taskIds()).toHaveLength(5);
});

test('a product task stopped for over an hour without action is cancelled into its failed backlog', async () => {
  const f = fixture();
  const old = NOW - STOPPED_TASK_LIMIT_MS - 60_000;
  const markdown = '---\ngoal: web\nmanager: web\n---\nBuild the library page\n';
  task(f.db, 'expired', 'stopped', { goal: 'web', manager: 'web', markdown }, 1);
  f.db
    .query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, 1, ?)')
    .run('expired', JSON.stringify({ state: 'exited', blocker: 'spec-conflict: two requirements disagree' }));
  event(f.db, 'expired', 'manager-event', old, { summary: 'spec-conflict: two requirements disagree' });
  task(f.db, 'second', 'stopped', { goal: 'web', manager: 'web', markdown: 'Second' }, 2);
  event(f.db, 'second', 'stopped', old);
  task(f.db, 'recent', 'stopped', { goal: 'web', manager: 'web', markdown: 'Recent' }, 3);
  event(f.db, 'recent', 'stopped', old);
  event(f.db, 'recent', 'prelaunch-contract-amended', NOW - 10 * 60_000);
  task(f.db, 'control', 'stopped', { goal: 'control-plane', manager: 'control-plane', markdown: 'Tools' }, 4);
  event(f.db, 'control', 'stopped', old);
  task(f.db, 'stabilize', 'stopped', { goal: 'web', manager: 'web', target: 'stabilize', markdown: 'Fix' }, 5);
  event(f.db, 'stabilize', 'stopped', old);
  task(f.db, 'proof', 'stopped', { goal: 'web', manager: 'web', kind: 'verification', markdown: 'Proof' }, 6);
  event(f.db, 'proof', 'stopped', old);
  task(f.db, 'retrying', 'stopped', { goal: 'web', manager: 'web', markdown: 'Retry' }, 7);
  event(f.db, 'retrying', 'stopped', old);
  f.db
    .query('INSERT INTO worker_retry_intents(task_id, attempt, body) VALUES (?, 1, ?)')
    .run('retrying', JSON.stringify({ status: 'pending', options: {} }));

  const sweep = await sweepBacklog(f.runtime);

  expect(sweep.expired.map((entry) => entry.taskId)).toEqual(['expired', 'second']);
  expect(f.cancelled).toEqual(['expired', 'second']);
  const failed = join(f.state, 'backlog', 'web', 'failed');
  expect(readFileSync(join(failed, 'expired.md'), 'utf8')).toBe(markdown);
  const reason = readFileSync(join(failed, 'expired.reason'), 'utf8');
  expect(reason).toContain('branch worker/expired');
  expect(reason).toContain('spec-conflict: two requirements disagree');
  expect(existsSync(join(f.state, 'backlog', 'control-plane'))).toBe(false);
  const events = f.inbox.pending('web');
  expect(events).toHaveLength(1);
  expect(events[0]!.event.summary).toContain('Stopped-task limit: 2 task(s)');
  expect(events[0]!.event.summary).toContain('expired, second');

  // A cancelled task is no longer stopped, so the next sweep does nothing more.
  expect((await sweepBacklog(f.runtime)).expired).toEqual([]);
});

test('a running manager below eight ready briefs is woken at most once an hour', async () => {
  const f = fixture({ workerCap: 0 });
  manager(f.db, 'web', { kind: 'managed', status: 'running', goal: 'web', goalState: { status: 'active' } });
  manager(f.db, 'search', { kind: 'managed', status: 'running', goal: 'search', goalState: { status: 'active' } });
  manager(f.db, 'paused', { kind: 'managed', status: 'paused', goal: 'paused' });
  manager(f.db, 'limited', {
    kind: 'managed',
    status: 'running',
    goal: 'limited',
    goalState: { status: 'budgetLimited' },
  });
  manager(f.db, 'supermanager', { kind: 'resident-supermanager', status: 'running', threadId: 'session' });
  for (const [goal, count] of [
    ['web', 7],
    ['search', 8],
  ] as const)
    for (let i = 0; i < count; i++) brief(f.state, goal, `${i}.md`, 60_000);
  for (const name of ['ignored.txt', '.hidden.md']) writeFileSync(join(f.state, 'backlog', 'web', name), 'ignored\n');

  expect((await sweepBacklog(f.runtime)).woken).toEqual(['web']);
  const events = f.inbox.pending('web');
  expect(events).toHaveLength(1);
  expect(events[0]!.event.summary).toContain('Backlog low: 7 ready brief(s)');
  expect(events[0]!.event.summary).toContain('keep at least 8');
  expect(events[0]!.event.summary).toContain(join(f.state, 'backlog', 'web'));
  for (const id of ['search', 'paused', 'limited', 'supermanager']) expect(f.inbox.pending(id)).toHaveLength(0);

  f.clock.now += BACKLOG_WAKE_INTERVAL_MS - 1;
  expect((await sweepBacklog(f.runtime)).woken).toEqual([]);
  f.clock.now += 1;
  expect((await sweepBacklog(f.runtime)).woken).toEqual(['web']);
});

test('goal backlog status prints ready, dispatched and failed counts per Goal', async () => {
  const f = fixture();
  brief(f.state, 'web', 'ready.md', 60_000);
  mkdirSync(join(f.state, 'backlog', 'web', 'dispatched'), { recursive: true });
  writeFileSync(join(f.state, 'backlog', 'web', 'dispatched', 'task-1-old.md'), 'old\n');
  mkdirSync(join(f.state, 'backlog', 'imports', 'failed'), { recursive: true });
  writeFileSync(join(f.state, 'backlog', 'imports', 'failed', 'bad.md'), 'bad\n');
  writeFileSync(join(f.state, 'backlog', 'imports', 'failed', 'bad.reason'), 'why\n');
  const cli = join(import.meta.dir, 'fixtures/cli-runtime.ts');
  const run = async (...argv: string[]) => {
    const child = Bun.spawn([process.execPath, cli, 'backlog', ...argv], {
      env: { ...process.env, FAKE_GOAL_STATE: f.state, FAKE_GOAL_MAIN: f.state },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: await child.exited, stdout: await new Response(child.stdout).text() };
  };
  const json = await run('status', '--json');
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual([
    { goal: 'imports', ready: 0, dispatched: 0, failed: 1 },
    { goal: 'web', ready: 1, dispatched: 1, failed: 0 },
  ]);
  const table = await run('status');
  expect(table.code).toBe(0);
  expect(table.stdout.split('\n')[2]).toMatch(/^web\s+1\s+1\s+0$/);
  expect((await run('dispatch')).code).not.toBe(0);
});

test('stopped tasks are cancelled at most twenty per Goal per run, oldest first, with one event per owner', async () => {
  const f = fixture({ workerCap: 0 });
  const total = STOPPED_TASKS_PER_GOAL_PER_RUN + 5;
  for (let index = 0; index < total; index++) {
    const id = `web-${String(index).padStart(2, '0')}`;
    task(f.db, id, 'stopped', { goal: 'web', manager: 'web', markdown: id }, index + 1);
    // Later sequence numbers stopped earlier, so the oldest stop is not the first row.
    event(f.db, id, 'stopped', NOW - STOPPED_TASK_LIMIT_MS - (index + 1) * 60_000);
  }
  task(f.db, 'search-1', 'stopped', { goal: 'search', manager: 'search', markdown: 'search' }, total + 1);
  event(f.db, 'search-1', 'stopped', NOW - STOPPED_TASK_LIMIT_MS - 60_000);

  const first = await sweepBacklog(f.runtime);

  const web = first.expired.filter((entry) => entry.goal === 'web').map((entry) => entry.taskId);
  expect(web).toHaveLength(STOPPED_TASKS_PER_GOAL_PER_RUN);
  expect(web[0]).toBe(`web-${String(total - 1).padStart(2, '0')}`);
  expect(web).not.toContain('web-00');
  expect(first.expired.filter((entry) => entry.goal === 'search')).toHaveLength(1);
  expect(f.inbox.pending('web')).toHaveLength(1);
  expect(f.inbox.pending('web')[0]!.event.summary).toContain(`${STOPPED_TASKS_PER_GOAL_PER_RUN} task(s)`);
  expect(f.inbox.pending('search')).toHaveLength(1);

  const second = await sweepBacklog(f.runtime);
  expect(second.expired.map((entry) => entry.taskId).sort()).toEqual([
    'web-00',
    'web-01',
    'web-02',
    'web-03',
    'web-04',
  ]);
  expect(f.inbox.pending('web')).toHaveLength(2);
});

test('a run is single-flight: while another holds the backlog lease it does nothing', async () => {
  const f = fixture();
  brief(f.state, 'web', 'waits.md', 60_000);
  const held = acquireDirectoryLease(join(f.state, 'leases', 'backlog'));
  try {
    expect(await sweepBacklog(f.runtime)).toMatchObject({ skipped: true, dispatched: [] });
    expect(existsSync(join(f.state, 'backlog', 'web', 'waits.md'))).toBe(true);
  } finally {
    held.release();
  }
  expect((await sweepBacklog(f.runtime)).dispatched.map((entry) => entry.brief)).toEqual(['waits.md']);
  // The brief's write time stays visible to turn accounting after the run moved it.
  const row = f.db.query("SELECT last_written_at FROM backlog_goals WHERE goal='web'").get() as {
    last_written_at: number;
  };
  expect(row.last_written_at).toBe(NOW - 60_000);
});
