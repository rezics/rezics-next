import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
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
