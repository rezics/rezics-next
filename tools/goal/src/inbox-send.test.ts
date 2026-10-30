import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { migrate, openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SharedInboxQueries } from './inbox-shared.ts';
import { temporaryDirectory } from './test-support.ts';

const cli = join(import.meta.dir, 'fixtures/cli-runtime.ts');

async function goal(env: Record<string, string | undefined>, ...argv: string[]): Promise<number> {
  return await Bun.spawn([process.execPath, cli, ...argv], { env, stdout: 'ignore', stderr: 'ignore' }).exited;
}

test('inbox send delivers a one-line event from the calling manager to another manager', async () => {
  const t = temporaryDirectory(); const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const env = { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path, GOAL_MANAGER: 'kernel' };
  try {
    expect(await goal(env, 'inbox', 'send', 'supermanager', 'spec-conflict', 'Which service owns account IDs?',
      '--task', 'task-1', '--evidence', '/fixture/evidence')).toBe(0);
    const entries = inbox.read('supermanager');
    expect(entries.map(entry => entry.event)).toEqual([{ managerId: 'supermanager', kind: 'spec-conflict',
      summary: 'Which service owns account IDs?', taskId: 'task-1', evidencePath: '/fixture/evidence', from: 'kernel' }]);
  } finally { db.close(); t.close(); }
});

test('inbox send without a calling manager comes from the supermanager', async () => {
  const t = temporaryDirectory(); const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const env = { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path, GOAL_MANAGER: undefined };
  try {
    expect(await goal(env, 'inbox', 'send', 'kernel', 'instruction', 'Expose subjects through Eden first')).toBe(0);
    expect(inbox.read('kernel').map(entry => entry.event.from)).toEqual(['supermanager']);
  } finally { db.close(); t.close(); }
});

test('inbox send refuses recorded-only kinds and multi-line summaries', async () => {
  const t = temporaryDirectory(); const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const env = { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path, GOAL_MANAGER: 'kernel' };
  try {
    expect(await goal(env, 'inbox', 'send', 'supermanager', 'merged', 'Task merged')).not.toBe(0);
    expect(await goal(env, 'inbox', 'send', 'supermanager', 'instruction', 'two\nlines')).not.toBe(0);
    expect(inbox.read('supermanager')).toEqual([]);
  } finally { db.close(); t.close(); }
});

test('inbox send refuses a manager whose Goal is complete and names the supermanager', async () => {
  const t = temporaryDirectory(); const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  migrate(db, [{ module: 'managers', version: 1, sql: 'CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL);' }]);
  db.run('INSERT INTO manager_sessions VALUES (?, ?)', ['kernel', JSON.stringify({ id: 'kernel', status: 'complete' })]);
  const env = { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path, GOAL_MANAGER: 'accounts' };
  try {
    expect(await goal(env, 'inbox', 'send', 'kernel', 'instruction', 'Own the schema dump timeout')).not.toBe(0);
    expect(inbox.read('kernel')).toEqual([]);
    expect(await goal(env, 'inbox', 'send', 'supermanager', 'instruction', 'Own the schema dump timeout')).toBe(0);
  } finally { db.close(); t.close(); }
});

test('inbox send stores explicit kinds, exact reply links, document references and escalation metadata', async () => {
  const t = temporaryDirectory(); const db = openDb(join(t.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, t.path);
  const shared = new SharedInboxQueries(db);
  const env = { ...process.env, FAKE_GOAL_STATE: t.path, FAKE_GOAL_MAIN: t.path, GOAL_MANAGER: 'kernel' };
  try {
    expect(await goal(env, 'inbox', 'send', 'accounts', 'question', 'Which ID format should I use?', '--task', 'task-42')).toBe(0);
    const root = shared.log({ grep: 'Which ID format' }).entries[0]!;
    expect(await goal(env, 'inbox', 'send', 'kernel', 'question', 'Is v2 required?', '--reply', String(root.id))).toBe(0);
    expect(await goal(env, 'inbox', 'send', 'accounts', 'decision', 'Use v2 signed IDs', '--reply', String(root.id),
      '--document', '{"path":"docs/identity.md","change":"Added the signed ID rule"}',
      '--escalation', '{"target":"supermanager","reason":"Dependency owner is blocked"}')).toBe(0);
    const thread = shared.thread(root.id);
    expect(thread.entries.map((entry) => entry.replyToId)).toEqual([null, root.id, root.id]);
    expect(thread.entries[1]?.kind).toBe('question');
    expect(thread.entries[2]?.kind).toBe('decision');
    expect(thread.entries[2]?.task).toBe('task-42');
    expect(thread.entries[2]?.documentRefs).toEqual([{ path: 'docs/identity.md', change: 'Added the signed ID rule' }]);
    expect(thread.entries[2]?.escalation).toEqual({ target: 'supermanager', reason: 'Dependency owner is blocked' });
    expect(await goal(env, 'inbox', 'send', 'accounts', 'decision', 'Malformed reference', '--reply', 'missing')).not.toBe(0);
    expect(await goal(env, 'inbox', 'send', 'accounts', 'info', 'Malformed option', '--fake', 'value')).not.toBe(0);
    expect(inbox.pending('accounts').map((entry) => entry.event.summary)).toEqual(['Which ID format should I use?', 'Use v2 signed IDs']);
  } finally { db.close(); t.close(); }
});
