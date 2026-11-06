import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sweepBacklog, type BacklogRuntime } from './backlog.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import {
  confirmedBacklogOwner,
  setUrgentGrant,
  type AuthenticatedManager,
} from './priority-authority.ts';
import { defaultPolicy } from './policy.ts';
import { WorkerStore } from './store.ts';
import { markdown, temporaryDirectory } from './test-support.ts';

const NOW = Date.UTC(2026, 10, 6, 12, 0);
const SUPER = 'supermanager';
const complete = markdown.replace('lines: 100', `lines: ${defaultPolicy.brief.minimumEstimateLines}`);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function session(db: ReturnType<typeof openDb>, id: string, extra: Record<string, unknown> = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.query('INSERT OR REPLACE INTO manager_sessions(id, state) VALUES (?, ?)').run(
    id,
    JSON.stringify({
      id,
      kind: 'managed',
      engine: 'codex',
      status: 'running',
      threadId: `${id}-session`,
      ...extra,
    }),
  );
}

function fixture() {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'goal.sqlite'));
  new WorkerStore(db);
  const inbox = new SqliteManagerInbox(db, temporary.path, () => NOW);
  const dispatched: { file: string; actor: AuthenticatedManager | null | undefined }[] = [];
  const runtime: BacklogRuntime = {
    db,
    stateDirectory: temporary.path,
    inbox,
    now: () => NOW,
    workerCap: 32,
    supermanager: SUPER,
    async dispatch(file, actor) {
      dispatched.push({ file, actor });
      return `task-${dispatched.length}`;
    },
    async continueTask() {},
    async cancel() {},
  };
  cleanups.push(() => {
    db.close();
    temporary.close();
  });
  return { db, inbox, runtime, dispatched, state: temporary.path };
}

function ready(state: string, goal: string, name: string, text: string) {
  const directory = join(state, 'backlog', goal);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  const at = (NOW - 60_000) / 1000;
  utimesSync(file, at, at);
  return file;
}

function product(goal: string, manager: string, urgent = false) {
  return complete
    .replace('goal: fixture', `goal: ${goal}\nmanager: ${manager}`)
    .replace('criticalPath: false', `${urgent ? 'urgent: true\n' : ''}criticalPath: false`);
}

test('an urgent backlog brief dispatches as the confirmed manager when that manager holds an urgent grant, and is returned with the grant reason when it does not', async () => {
  const f = fixture();
  session(f.db, 'content', { goal: 'content' });
  session(f.db, SUPER);
  setUrgentGrant(f.db, SUPER, 'content', true, { id: SUPER, sessionId: `${SUPER}-session` });
  ready(f.state, 'content', 'repair.md', product('content', 'content', true));
  ready(f.state, 'web', 'foreign.md', product('web', 'content', true));

  const granted = await sweepBacklog(f.runtime);

  expect(granted.dispatched.map((entry) => `${entry.goal}/${entry.brief}`)).toEqual(['content/repair.md']);
  expect(f.dispatched[0]?.actor).toEqual({ id: 'content', sessionId: 'content-session' });
  expect(confirmedBacklogOwner(f.db, 'content', 'content')).toEqual({
    id: 'content',
    sessionId: 'content-session',
  });
  expect(granted.returned).toEqual([
    expect.objectContaining({
      goal: 'web',
      brief: 'foreign.md',
      reason: 'urgent dispatch requires an authenticated manager session',
    }),
  ]);

  setUrgentGrant(f.db, SUPER, 'content', false, { id: SUPER, sessionId: `${SUPER}-session` });
  ready(f.state, 'content', 'repair.md', product('content', 'content', true));
  const revoked = await sweepBacklog(f.runtime);
  expect(revoked.dispatched).toEqual([]);
  expect(revoked.returned).toEqual([
    expect.objectContaining({
      goal: 'content',
      brief: 'repair.md',
      reason: 'urgent dispatch requires the supermanager or an active urgent grant',
    }),
  ]);
  expect(readFileSync(join(f.state, 'backlog', 'content', 'returned', 'repair.reason'), 'utf8')).toContain(
    'active urgent grant',
  );
});

test('non-urgent backlog dispatch is unchanged', async () => {
  const f = fixture();
  session(f.db, 'web', { goal: 'web' });
  ready(f.state, 'web', 'ordinary.md', product('web', 'web'));
  const sweep = await sweepBacklog(f.runtime);
  expect(sweep.dispatched.map((entry) => `${entry.goal}/${entry.brief}`)).toEqual(['web/ordinary.md']);
  expect(sweep.returned).toEqual([]);
  expect(f.dispatched[0]?.actor).toBeNull();
});
