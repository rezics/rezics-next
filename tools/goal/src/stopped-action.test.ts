import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sweepBacklog } from './backlog.ts';
import { openDb } from './db.ts';
import { briefProposalHash } from './durable-follow-up.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerStore } from './store.ts';
import { brief, temporaryDirectory } from './test-support.ts';
import { proofFingerprint } from './verification.ts';
import {
  grantWorkerTypingRecovery,
  workerCheckBudgetDirectory,
  workerCheckHostContentTree,
} from './worker-check-budget.ts';
import { sweepWidthGovernor } from './width-governor.ts';

const webCompiler = ['bun', 'run', '--cwd', 'apps/web', 'typecheck'];

function git(worktree: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
}

function prepareTypingRecovery(
  db: ReturnType<typeof openDb>,
  stateDirectory: string,
  taskId: string,
  goal: string,
  actorId: string,
  consumed: boolean,
  sequence: number,
  at: string,
  terminal = false,
): void {
  const worktree = join(stateDirectory, 'worktrees', taskId);
  mkdirSync(join(worktree, 'apps/web/scripts'), { recursive: true });
  mkdirSync(join(worktree, 'apps/web/src'), { recursive: true });
  git(worktree, ['init', '-q']);
  git(worktree, ['config', 'user.name', 'Goal fixture']);
  git(worktree, ['config', 'user.email', 'goal-fixture@example.invalid']);
  writeFileSync(
    join(worktree, 'apps/web/package.json'),
    JSON.stringify({ name: '@rezics/web', scripts: { typecheck: 'bun scripts/typecheck.ts' } }),
  );
  writeFileSync(join(worktree, 'apps/web/tsconfig.json'), '{"include":["src/**/*.ts"]}');
  writeFileSync(join(worktree, 'apps/web/scripts/typecheck.ts'), 'export {}\n');
  writeFileSync(join(worktree, 'apps/web/src/reader.ts'), 'export const reader = true\n');
  git(worktree, ['add', 'apps/web']);
  git(worktree, ['commit', '-m', 'Prepare consumed typing recovery fixture']);

  const contract = { ...brief(), goal, manager: goal };
  const task = {
    id: taskId,
    sequence,
    currentAttempt: 1,
    state: 'stopped',
    createdAt: at,
    worktree,
    brief: contract,
  };
  db.query('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)').run(taskId, sequence, JSON.stringify(task));
  const result = 'Compiler input closure is unavailable for the last check-host typecheck.';
  const grant = grantWorkerTypingRecovery({
    stateDirectory,
    database: db.filename,
    taskId,
    attempt: 1,
    worktree,
    command: webCompiler,
    actor: { id: actorId, sessionId: `${actorId}-session` },
  });
  const checks = [grant.checkId];
  db.query('INSERT INTO worker_attempts VALUES (?, 1, ?)').run(
    taskId,
    JSON.stringify({
      taskId,
      attempt: 1,
      state: 'exited',
      endedAt: at,
      exitCode: 0,
      result,
      failureKind: null,
      blocker: null,
      checks,
      typingEvidencePending: { result, command: webCompiler },
    }),
  );
  const authorization = {
    actor: { id: actorId, sessionId: `${actorId}-session` },
    token: grant.token,
    identity: grant.identity,
    command: grant.command,
    checkId: grant.checkId,
  };
  db.query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,1,?,?,?)').run(
    taskId,
    'typing-recovery-authorized',
    at,
    JSON.stringify(authorization),
  );
  if (consumed) {
    const budget = workerCheckBudgetDirectory(stateDirectory, taskId, 1);
    const checkRoot = join(worktree, '.temp/goal/checks');
    mkdirSync(join(checkRoot, 'results'), { recursive: true });
    writeFileSync(join(checkRoot, 'results', 'unrelated.json'), '{not a check result');
    writeFileSync(
      join(budget, '1'),
      JSON.stringify({
        content: workerCheckHostContentTree(worktree),
        typingRecovery: { token: grant.token, checkId: grant.checkId, physicalRunId: grant.physicalRunId },
      }),
    );
    writeFileSync(join(budget, 'typing-recovery', `${grant.token}.json`), JSON.stringify({ ...grant, stamp: '1' }));
    if (terminal) {
      mkdirSync(join(checkRoot, 'custody/history'), { recursive: true });
      writeFileSync(
        join(checkRoot, 'results', `${grant.checkId}.json`),
        JSON.stringify({
          id: grant.checkId,
          status: 'finished',
          exitCode: 0,
          cwd: worktree,
          physicalRunId: grant.physicalRunId,
          ownership: { taskId, attempt: 1 },
        }),
      );
      writeFileSync(
        join(checkRoot, 'custody/history', `${grant.checkId}.${grant.physicalRunId}.json`),
        JSON.stringify({
          version: 1,
          id: grant.checkId,
          cwd: worktree,
          physicalRunId: grant.physicalRunId,
          status: 'finished',
          exitCode: 0,
          remoteExpected: false,
          terminalProof: { local: true, resultKnown: true, remote: null },
        }),
      );
    }
  }
}

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
    stopped('typing-only', 'typing', false, {
      exitCode: 0,
      typingEvidencePending: { result: 'Compiler input closure is unavailable for the last check-host typecheck.' },
    });
    for (const [taskId, goal, owned] of [
      ['f8a9f5e3-9e8a-4913-8003-0aefdd0faad1', 'preserved', true],
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
    const acceptedCommit = 'a'.repeat(40);
    const successor = {
      id: 'accepted-successor',
      sequence: ++sequence,
      currentAttempt: 1,
      state: 'integrated',
      integratedCommit: acceptedCommit,
      brief: { goal: 'accepted', manager: 'accepted' },
    };
    db.query('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)').run(
      successor.id,
      successor.sequence,
      JSON.stringify(successor),
    );
    const acceptedSource = stopped('accepted-source', 'accepted', false, { exitCode: 0 });
    event('accepted-source', 'owner-contract-decision-accepted', {
      taskId: acceptedSource.id,
      attempt: 1,
      managerId: 'accepted',
      senderSessionId: 'current-owner-session',
      decisionId: 'accepted-successor-source',
      summary: 'Use the integrated successor for this preserved source.',
      contractSha256: briefProposalHash(acceptedSource.brief.markdown),
      acceptedSuccessor: { taskId: successor.id, commit: acceptedCommit },
    });

    const staleCommit = 'b'.repeat(40);
    const staleSuccessor = {
      ...successor,
      id: 'stale-successor',
      sequence: ++sequence,
      integratedCommit: staleCommit,
      brief: { goal: 'stale-successor', manager: 'stale-successor' },
    };
    db.query('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)').run(
      staleSuccessor.id,
      staleSuccessor.sequence,
      JSON.stringify(staleSuccessor),
    );
    const supersededSource = stopped('superseded-source', 'stale-successor', false, { exitCode: 0 });
    event('superseded-source', 'owner-contract-decision-accepted', {
      taskId: supersededSource.id,
      attempt: 1,
      managerId: 'stale-successor',
      senderSessionId: 'current-owner-session',
      decisionId: 'accepted-successor-superseded',
      summary: 'This accepted successor disposition is superseded.',
      contractSha256: briefProposalHash(supersededSource.brief.markdown),
      acceptedSuccessor: { taskId: staleSuccessor.id, commit: staleCommit },
    });
    event('superseded-source', 'owner-contract-decisions-superseded', { throughSequence: 100 });

    const width = await sweepWidthGovernor(db, inbox, now);
    expect(width.snapshot.system).toMatchObject({ stopped: 10, actionableStopped: 5 });
    expect(width.snapshot.goals.find(({ goal }) => goal === 'preserved')).toMatchObject({
      stopped: 4,
      actionableStopped: 0,
    });
    expect(width.snapshot.goals.find(({ goal }) => goal === 'accepted')).toMatchObject({
      stopped: 1,
      actionableStopped: 0,
    });
    expect(width.deliveredGoals).toEqual(['ordinary', 'stale-successor', 'typing', 'unreviewed']);
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
    expect(backlog.expired).toEqual([
      { goal: 'ordinary', taskId: 'ordinary-stop' },
      { goal: 'stale-successor', taskId: 'superseded-source' },
    ]);
    expect(cancelled).toEqual(['ordinary-stop', 'superseded-source']);
    const typingEvents = inbox.pending('typing');
    expect(
      typingEvents.some(({ event: delivered }) =>
        delivered.summary.includes('typing-recover typing-only --expected-attempt 1'),
      ),
    ).toBe(true);
    const row = db
      .query<{ body: string }, [string]>('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=1')
      .get('cancel-pending');
    expect(JSON.parse(row!.body).terminationIntent).toEqual(intent);
  } finally {
    db.close();
    temp.close();
  }
});

test('consumed owner and operations typing grants stay quiet until custody resolves', async () => {
  const temp = temporaryDirectory();
  const db = openDb(join(temp.path, 'goal.sqlite'));
  try {
    new WorkerStore(db);
    const now = Date.UTC(2026, 0, 2);
    const old = new Date(now - 2 * 60 * 60_000).toISOString();
    const inbox = new SqliteManagerInbox(db, temp.path, () => now);
    prepareTypingRecovery(db, temp.path, 'consumed-owner', 'quiet-owner', 'quiet-owner', true, 1, old);
    prepareTypingRecovery(db, temp.path, 'consumed-operations', 'quiet-operations', 'operations', true, 2, old);
    prepareTypingRecovery(db, temp.path, 'grant-awaiting-run', 'pending-grant', 'pending-grant', false, 3, old);
    const failedSource = {
      id: 'failed-source',
      sequence: 4,
      currentAttempt: 1,
      state: 'stopped',
      createdAt: old,
      worktree: join(temp.path, 'failed-source'),
      brief: { ...brief(), goal: 'failed-source-goal', manager: 'failed-source-goal' },
    };
    db.query('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)').run('failed-source', 4, JSON.stringify(failedSource));
    db.query('INSERT INTO worker_attempts VALUES (?, 1, ?)').run(
      'failed-source',
      JSON.stringify({
        taskId: 'failed-source',
        attempt: 1,
        state: 'exited',
        endedAt: old,
        exitCode: 1,
        failureKind: 'tool',
        result: 'Last check-host run failed its typecheck.',
      }),
    );
    db.query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,1,?,?,?)').run(
      'failed-source',
      'worker-exited',
      old,
      JSON.stringify({ result: 'Last check-host run failed its typecheck.' }),
    );
    const failedSuccessorCommit = 'c'.repeat(40);
    const failedSuccessor = {
      id: 'failed-source-successor',
      sequence: 6,
      currentAttempt: 1,
      state: 'integrated',
      integratedCommit: failedSuccessorCommit,
      brief: { goal: 'failed-source-goal', manager: 'failed-source-goal' },
    };
    db.query('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)').run(
      failedSuccessor.id,
      failedSuccessor.sequence,
      JSON.stringify(failedSuccessor),
    );
    db.query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,1,?,?,?)').run(
      'failed-source',
      'owner-contract-decision-accepted',
      old,
      JSON.stringify({
        taskId: 'failed-source',
        attempt: 1,
        managerId: 'failed-source-goal',
        senderSessionId: 'current-owner-session',
        decisionId: 'failed-source-successor',
        summary: 'This accepted successor does not erase the failed source result.',
        contractSha256: briefProposalHash(failedSource.brief.markdown),
        acceptedSuccessor: { taskId: failedSuccessor.id, commit: failedSuccessorCommit },
      }),
    );
    prepareTypingRecovery(db, temp.path, 'consumed-terminal', 'terminal-result', 'terminal-result', true, 5, old, true);

    const width = await sweepWidthGovernor(db, inbox, now);
    expect(width.snapshot.system).toMatchObject({ stopped: 5, actionableStopped: 3 });
    expect(width.snapshot.goals.find(({ goal }) => goal === 'quiet-owner')).toMatchObject({
      stopped: 1,
      actionableStopped: 0,
    });
    expect(width.snapshot.goals.find(({ goal }) => goal === 'quiet-operations')).toMatchObject({
      stopped: 1,
      actionableStopped: 0,
    });
    expect(width.deliveredGoals).toEqual(['failed-source-goal', 'pending-grant', 'terminal-result']);

    const recoverCalls: string[] = [];
    const cancelled: string[] = [];
    const backlog = await sweepBacklog({
      db,
      inbox,
      stateDirectory: temp.path,
      now: () => now,
      async cancel(taskId) {
        cancelled.push(taskId);
      },
      async recoverTyping({ taskId }) {
        recoverCalls.push(taskId);
        return { status: 'pending', result: 'The authorized compiler check still needs to run.' };
      },
      async continueTask() {},
      async dispatch() {
        return 'unexpected-dispatch';
      },
    });
    expect(backlog.expired).toEqual([{ goal: 'failed-source-goal', taskId: 'failed-source' }]);
    expect(cancelled).toEqual(['failed-source']);
    expect(recoverCalls).toEqual(['grant-awaiting-run', 'consumed-terminal']);
  } finally {
    db.close();
    temp.close();
  }
});
