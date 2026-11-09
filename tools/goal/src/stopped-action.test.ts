import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sweepBacklog } from './backlog.ts';
import { openDb } from './db.ts';
import { briefProposalHash } from './durable-follow-up.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerStore } from './store.ts';
import { brief, temporaryDirectory } from './test-support.ts';
import { proofFingerprint } from './verification.ts';
import { sweepWidthGovernor } from './width-governor.ts';

test('preserved terminal proofs and unresolved cancels stay counted but cause no width wake or expiry', async () => {
  const temp = temporaryDirectory();
  const db = openDb(join(temp.path, 'goal.sqlite'));
  try {
    new WorkerStore(db);
    const now = Date.UTC(2026, 0, 2);
    const old = new Date(now - 2 * 60 * 60_000).toISOString();
    const inbox = new SqliteManagerInbox(db, temp.path, () => now);
    let sequence = 0;
    const stopped = (id: string, goal: string, verification = false, attemptFields: object = {}) => {
      const contract = {
        ...brief(),
        goal,
        manager: goal,
        ...(verification
          ? {
              kind: 'verification' as const,
              paths: [],
              proof: { journey: 'Fixture proof', sourceTasks: ['original'], sourceCommit: 'a'.repeat(40) },
              acceptance: { ...brief().acceptance, command: ['bun', 'test', 'fixture.test.ts'] },
            }
          : {}),
      };
      const worktree = join(temp.path, id);
      const task = {
        id,
        currentAttempt: 1,
        state: 'stopped',
        createdAt: old,
        worktree,
        brief: contract,
        ...(verification ? { proofAuthorization: { fingerprint: proofFingerprint(contract) } } : {}),
      };
      db.query('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)').run(id, ++sequence, JSON.stringify(task));
      db.query('INSERT INTO worker_attempts VALUES (?, 1, ?)').run(
        id,
        JSON.stringify({ taskId: id, attempt: 1, state: 'exited', endedAt: old, ...attemptFields }),
      );
      return task;
    };
    const event = (taskId: string, kind: string, body: object) =>
      db
        .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,1,?,?,?)')
        .run(taskId, kind, old, JSON.stringify(body));
    const terminal = (taskId: string) =>
      db
        .query('INSERT INTO worker_records VALUES (?,1,?)')
        .run(taskId, JSON.stringify({ proof: { status: 'terminal', passed: false } }));
    const intent = { operation: 'cancel', state: 'unknown', processIdentity: 'unknown', process: null };
    stopped('cancel-pending', 'preserved', false, { terminationIntent: intent });
    stopped('operator-paused', 'preserved', false, {
      state: 'stopped',
      terminationIntent: { operation: 'stop', requestedAt: old, state: 'complete', settledAt: old },
    });
    stopped('routed-proof', 'preserved', true);
    terminal('routed-proof');
    event('routed-proof', 'proof-failure-routed', { managerId: 'preserved' });
    stopped('unreviewed-proof', 'unreviewed', true);
    terminal('unreviewed-proof');
    event('unreviewed-proof', 'proof-failure-routed', { managerId: 'former-owner' });
    stopped('ordinary-stop', 'ordinary');
    for (const [taskId, goal, owned] of [
      ['historical-proof', 'preserved', true],
      ['wrong-receipt', 'unreviewed', false],
    ] as const) {
      const check = crypto.randomUUID();
      const task = stopped(taskId, goal, true, { checks: [check] });
      event(taskId, 'owner-contract-decision-accepted', {
        taskId,
        attempt: 1,
        managerId: goal,
        senderSessionId: 'authenticated-fixture',
        decisionId: 'preserved-terminal-native-proof-20260101',
        summary: 'Preserve the reviewed original result.',
        contractSha256: briefProposalHash(task.brief.markdown),
      });
      const results = join(task.worktree, '.temp/goal/checks/results');
      mkdirSync(results, { recursive: true });
      writeFileSync(
        join(results, `${check}.json`),
        JSON.stringify({
          id: check,
          status: 'finished',
          exitCode: 1,
          cwd: task.worktree,
          argv: task.brief.acceptance.command,
          ownership: { taskId: owned ? taskId : 'foreign', attempt: 1 },
        }),
      );
    }
    const width = await sweepWidthGovernor(db, inbox, now);
    expect(width.snapshot.system).toMatchObject({ stopped: 7, actionableStopped: 3 });
    expect(width.snapshot.goals.find(({ goal }) => goal === 'preserved')).toMatchObject({
      stopped: 4,
      actionableStopped: 0,
    });
    expect(width.deliveredGoals).toEqual(['ordinary', 'unreviewed']);
    const cancelled: string[] = [];
    const backlog = await sweepBacklog({
      db,
      inbox,
      stateDirectory: temp.path,
      now: () => now,
      async cancel(id) {
        cancelled.push(id);
      },
      async continueTask() {},
      async dispatch() {
        throw new Error('unexpected dispatch');
      },
    });
    expect(backlog.expired).toEqual([{ goal: 'ordinary', taskId: 'ordinary-stop' }]);
    expect(cancelled).toEqual(['ordinary-stop']);
    const row = db
      .query<{ body: string }, [string]>('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=1')
      .get('cancel-pending');
    expect(JSON.parse(row!.body).terminationIntent).toEqual(intent);
  } finally {
    db.close();
    temp.close();
  }
});
