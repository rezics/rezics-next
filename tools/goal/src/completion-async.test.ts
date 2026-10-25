import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { completionChecker } from './completion.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ManagerSessions, type ManagerSpec } from './managers.ts';
import { temporaryDirectory, repository } from './test-support.ts';

test('manager complete returns at once and the verdict arrives as an inbox event', async () => {
  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'state.sqlite'));
  const inbox = new SqliteManagerInbox(db, temporary.path);
  let finish!: (evidence: { passed: boolean; evidencePath: string; summary: string }) => void;
  let started!: () => void;
  const checkStarted = new Promise<void>(resolve => { started = resolve; });
  const managers = new ManagerSessions(db, inbox, {
    windows: { register: () => '@1', unregister() {} },
    checkCompletion: () => { started(); return new Promise(resolve => { finish = resolve; }); },
    command: ['goal'],
  });
  const spec: ManagerSpec = {
    id: 'manager', goal: 'refactor', objective: 'Finish', brief: 'Manage', cwd: temporary.path,
    engine: 'claude', pool: { id: 'sol', codexHome: join(temporary.path, 'codex-home') },
    budget: 1000, effort: 'high', supermanager: 'supervisor',
    limits: { turns: 20, turnsWithoutDecision: 10, wallMs: 60_000 },
  };
  try {
    await managers.start(spec);
    const request = managers.complete(spec.id);
    await checkStarted;
    let settled = false;
    void request.then(() => { settled = true; });
    await Promise.resolve();
    finish({ passed: false, evidencePath: join(temporary.path, 'completion.log'), summary: 'First failure: assertion failed' });
    await managers.flush();
    expect(settled).toBe(true);
    for (const id of [spec.id, spec.supermanager]) {
      expect(inbox.pending(id).map(entry => entry.event.kind)).toEqual(['goal-unmet']);
      expect(inbox.pending(id)[0]?.event.summary).toContain('First failure');
    }
  } finally {
    await managers.close(); db.close(); temporary.close();
  }
});

test('a completion gated on an ancestor of main is accepted', async () => {
  const repo = repository();
  try {
    const check = completionChecker({
      mainCheckout: repo.main, stateDirectory: join(repo.path, 'state'), worktreeRoot: join(repo.path, 'trees'),
      condition: () => ({ taskIds: [], gate: ['true'] }), mergedTasks: async () => new Set(),
      runGate: async () => {
        repo.commit('later main commit');
        return { passed: true, timedOut: false, output: '' };
      },
    });
    expect((await check('refactor')).passed).toBe(true);
  } finally { repo.close(); }
});
