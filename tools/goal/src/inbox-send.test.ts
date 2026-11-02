import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { migrate, openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SharedInboxQueries } from './inbox-shared.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';

const cli = join(import.meta.dir, 'fixtures/cli-runtime.ts');

async function goal(env: Record<string, string | undefined>, ...argv: string[]): Promise<number> {
  return await Bun.spawn([process.execPath, cli, ...argv], { env, stdout: 'ignore', stderr: 'ignore' }).exited;
}

function managerSession(db: ReturnType<typeof openDb>, id: string, threadId: string, status = 'running'): void {
  db.run('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.query('INSERT INTO manager_sessions(id, state) VALUES (?, ?)').run(
    id,
    JSON.stringify({
      id,
      kind: 'managed',
      status,
      threadId,
    }),
  );
}

function workerAttempt(
  db: ReturnType<typeof openDb>,
  id: string,
  goalName: string,
  manager: string,
  currentAttempt: number,
  persistedAttempt = currentAttempt,
  attemptState = 'running',
): void {
  new WorkerStore(db);
  db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
    id,
    currentAttempt,
    currentAttempt,
    JSON.stringify({
      id,
      currentAttempt,
      state: 'running',
      brief: { goal: goalName, manager },
    }),
  );
  db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
    id,
    persistedAttempt,
    JSON.stringify({ taskId: id, attempt: persistedAttempt, state: attemptState }),
  );
}

test('inbox send delivers a one-line event from the calling manager to another manager', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  managerSession(db, 'kernel', 'kernel-thread');
  const env = {
    ...process.env,
    FAKE_GOAL_STATE: t.path,
    FAKE_GOAL_MAIN: t.path,
    GOAL_MANAGER: 'kernel',
    CODEX_THREAD_ID: 'kernel-thread',
  };
  try {
    expect(
      await goal(
        env,
        'inbox',
        'send',
        'supermanager',
        'spec-conflict',
        'Which service owns account IDs?',
        '--task',
        'task-1',
        '--evidence',
        '/fixture/evidence',
      ),
    ).toBe(0);
    const entries = inbox.read('supermanager');
    expect(entries.map((entry) => entry.event)).toEqual([
      {
        managerId: 'supermanager',
        kind: 'spec-conflict',
        summary: 'Which service owns account IDs?',
        taskId: 'task-1',
        evidencePath: '/fixture/evidence',
        from: 'kernel',
      },
    ]);
  } finally {
    db.close();
    t.close();
  }
});

test('inbox send requires an authenticated sender instead of impersonating the supermanager', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const env = { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path, GOAL_MANAGER: undefined };
  try {
    expect(await goal(env, 'inbox', 'send', 'kernel', 'instruction', 'Expose subjects through Eden first')).not.toBe(0);
    expect(inbox.read('kernel')).toEqual([]);
  } finally {
    db.close();
    t.close();
  }
});

test('inbox send refuses recorded-only kinds and multi-line summaries', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const env = { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path, GOAL_MANAGER: 'kernel' };
  try {
    expect(await goal(env, 'inbox', 'send', 'supermanager', 'merged', 'Task merged')).not.toBe(0);
    expect(await goal(env, 'inbox', 'send', 'supermanager', 'instruction', 'two\nlines')).not.toBe(0);
    expect(inbox.read('supermanager')).toEqual([]);
  } finally {
    db.close();
    t.close();
  }
});

test('inbox send refuses a manager whose Goal is complete and names the supermanager', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  migrate(db, [
    {
      module: 'managers',
      version: 1,
      sql: 'CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);',
    },
  ]);
  db.run('INSERT INTO manager_sessions VALUES (?, ?)', [
    'kernel',
    JSON.stringify({ id: 'kernel', status: 'complete' }),
  ]);
  managerSession(db, 'accounts', 'accounts-thread');
  const env = {
    ...process.env,
    FAKE_GOAL_STATE: t.path,
    FAKE_GOAL_MAIN: t.path,
    GOAL_MANAGER: 'accounts',
    CODEX_THREAD_ID: 'accounts-thread',
  };
  try {
    expect(await goal(env, 'inbox', 'send', 'kernel', 'instruction', 'Own the schema dump timeout')).not.toBe(0);
    expect(inbox.read('kernel')).toEqual([]);
    expect(await goal(env, 'inbox', 'send', 'supermanager', 'instruction', 'Own the schema dump timeout')).toBe(0);
  } finally {
    db.close();
    t.close();
  }
});

test('inbox send stores explicit kinds, exact reply links, document references and escalation metadata', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const shared = new SharedInboxQueries(db);
  managerSession(db, 'kernel', 'kernel-thread');
  const env = {
    ...process.env,
    FAKE_GOAL_STATE: t.path,
    FAKE_GOAL_MAIN: t.path,
    GOAL_MANAGER: 'kernel',
    CODEX_THREAD_ID: 'kernel-thread',
  };
  try {
    expect(
      await goal(env, 'inbox', 'send', 'accounts', 'question', 'Which ID format should I use?', '--task', 'task-42'),
    ).toBe(0);
    const root = shared.log({ grep: 'Which ID format' }).entries[0]!;
    expect(await goal(env, 'inbox', 'send', 'kernel', 'question', 'Is v2 required?', '--reply', String(root.id))).toBe(
      0,
    );
    expect(
      await goal(
        env,
        'inbox',
        'send',
        'accounts',
        'decision',
        'Use v2 signed IDs',
        '--reply',
        String(root.id),
        '--document',
        '{"path":"docs/identity.md","change":"Added the signed ID rule"}',
        '--escalation',
        '{"target":"supermanager","reason":"Dependency owner is blocked"}',
      ),
    ).toBe(0);
    const thread = shared.thread(root.id);
    expect(thread.entries.map((entry) => entry.replyToId)).toEqual([null, root.id, root.id]);
    expect(thread.entries[1]?.kind).toBe('question');
    expect(thread.entries[2]?.kind).toBe('decision');
    expect(thread.entries[2]?.task).toBe('task-42');
    expect(thread.entries[2]?.documentRefs).toEqual([{ path: 'docs/identity.md', change: 'Added the signed ID rule' }]);
    expect(thread.entries[2]?.escalation).toEqual({ target: 'supermanager', reason: 'Dependency owner is blocked' });
    expect(
      await goal(env, 'inbox', 'send', 'accounts', 'decision', 'Malformed reference', '--reply', 'missing'),
    ).not.toBe(0);
    expect(await goal(env, 'inbox', 'send', 'accounts', 'info', 'Malformed option', '--fake', 'value')).not.toBe(0);
    expect(inbox.pending('accounts').map((entry) => entry.event.summary)).toEqual([
      'Which ID format should I use?',
      'Use v2 signed IDs',
    ]);
  } finally {
    db.close();
    t.close();
  }
});

test('a fenced worker keeps its source identity while delivering a cross-owner handoff', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const shared = new SharedInboxQueries(db);
  workerAttempt(db, 'library-source', 'library-goal', 'library-manager', 4);
  workerAttempt(db, 'commerce-target', 'commerce-goal', 'commerce-manager', 1);
  managerSession(db, 'supermanager', 'parent-thread');
  const env = {
    ...process.env,
    FAKE_GOAL_STATE: t.path,
    FAKE_GOAL_MAIN: t.path,
    GOAL_MANAGER: 'supermanager',
    GOAL_TASK_ID: 'library-source',
    GOAL_ATTEMPT: '4',
    CODEX_THREAD_ID: 'parent-thread',
  };
  try {
    expect(
      await goal(
        env,
        'inbox',
        'send',
        'commerce-manager',
        'handoff',
        'Producer contract is ready',
        '--task',
        'commerce-target',
      ),
    ).toBe(0);
    const message = shared.log({ to: 'commerce-manager' }).entries[0]!;
    expect(message.from).toBe('worker:library-source/4');
    expect(message.task).toBe('commerce-target');
    expect(message.goal).toBe('commerce-goal');
    expect(message.event).toMatchObject({
      senderProvenance: { kind: 'worker', taskId: 'library-source', attempt: 4, ownerManager: 'library-manager' },
    });
    expect(inbox.pending('commerce-manager').map((entry) => entry.event.summary)).toEqual([
      'Producer contract is ready',
    ]);
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_turn_decisions'").get(),
    ).toBeNull();

    expect(
      await goal(
        env,
        'inbox',
        'send',
        'commerce-manager',
        'info',
        'Caller identity cannot be overridden',
        '--from',
        'supermanager',
      ),
    ).not.toBe(0);
    expect(shared.log({ to: 'commerce-manager' }).entries).toHaveLength(1);
  } finally {
    db.close();
    t.close();
  }
});

test('a stale worker source attempt cannot fall back to its inherited manager identity', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  workerAttempt(db, 'library-source', 'library-goal', 'library-manager', 5, 4, 'superseded');
  managerSession(db, 'supermanager', 'parent-thread');
  const env = {
    ...process.env,
    FAKE_GOAL_STATE: t.path,
    FAKE_GOAL_MAIN: t.path,
    GOAL_MANAGER: 'supermanager',
    GOAL_TASK_ID: 'library-source',
    GOAL_ATTEMPT: '4',
    CODEX_THREAD_ID: 'parent-thread',
  };
  try {
    expect(
      await goal(env, 'inbox', 'send', 'supermanager', 'question', 'Can this stale attempt ask a question?'),
    ).not.toBe(0);
    expect(inbox.pending('supermanager')).toEqual([]);
  } finally {
    db.close();
    t.close();
  }
});

test('a Goal manager may send six messages an hour of at most 600 characters; the supermanager is not capped', async () => {
  const t = temporaryDirectory();
  const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  managerSession(db, 'kernel', 'kernel-thread');
  managerSession(db, 'supermanager', 'super-thread');
  const base = { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path };
  const kernel = { ...base, GOAL_MANAGER: 'kernel', CODEX_THREAD_ID: 'kernel-thread' };
  const supermanager = { ...base, GOAL_MANAGER: 'supermanager', CODEX_THREAD_ID: 'super-thread' };
  try {
    expect(await goal(kernel, 'inbox', 'send', 'accounts', 'decision', 'x'.repeat(601))).not.toBe(0);
    for (let index = 1; index <= 6; index++)
      expect(await goal(kernel, 'inbox', 'send', 'accounts', 'decision', `Decision ${index}`)).toBe(0);
    expect(await goal(kernel, 'inbox', 'send', 'accounts', 'decision', 'Decision 7')).not.toBe(0);
    expect(await goal(kernel, 'inbox', 'send', 'accounts', 'decision', 'continuation written')).not.toBe(0);
    expect(await goal(kernel, 'inbox', 'send', 'supermanager', 'question', 'CONTINUATION WRITTEN')).not.toBe(0);
    expect(inbox.read('accounts').map((entry) => entry.event.summary)).toEqual(
      [1, 2, 3, 4, 5, 6].map((index) => `Decision ${index}`),
    );
    for (let index = 1; index <= 7; index++)
      expect(await goal(supermanager, 'inbox', 'send', 'kernel', 'instruction', `Direction ${index}`)).toBe(0);
    expect(inbox.read('kernel')).toHaveLength(7);
  } finally {
    db.close();
    t.close();
  }
});
