import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { cleanupReceiptPath, physicalHistoryPath, remoteRunCustodyPath } from '../../../scripts/check-custody.ts';
import { recoverWorkerTyping } from './typing-recovery.ts';
import {
  grantWorkerTypingRecovery,
  TYPING_RECOVERY_ENV,
  workerCheckBudgetDirectory,
  workerCheckHostActiveTypingRecovery,
  workerCheckHostAttemptCheckCustody,
  workerCheckHostAttemptHasResultlessCleanup,
  workerCheckHostContentTree,
} from './worker-check-budget.ts';
import { processIdentity } from './process.ts';
import type { Attempt } from './types.ts';
import {
  harness,
  prepareKernelCompilerFixture,
  temporaryDirectory,
  writeVerifiedResultlessCleanupEvidence,
} from './test-support.ts';

const compiler = ['bun', 'services/kernel/scripts/typecheck.ts'];
const webCompiler = ['bun', 'run', '--cwd', 'apps/web', 'typecheck'];

function recoveryProof(result: Awaited<ReturnType<typeof recoverWorkerTyping>>) {
  if (!('proof' in result)) throw new Error('Expected typing recovery to issue a compiler proof');
  return result.proof;
}

function prepareWebCompiler(worktree: string): void {
  mkdirSync(join(worktree, 'apps/web/scripts'), { recursive: true });
  mkdirSync(join(worktree, 'apps/web/src'), { recursive: true });
  writeFileSync(
    join(worktree, 'apps/web/package.json'),
    JSON.stringify({ name: '@rezics/web', scripts: { typecheck: 'bun scripts/typecheck.ts' } }),
  );
  writeFileSync(join(worktree, 'apps/web/tsconfig.json'), '{"include":["src/**/*.ts"]}');
  writeFileSync(join(worktree, 'apps/web/scripts/typecheck.ts'), 'export {}\n');
  writeFileSync(join(worktree, 'apps/web/src/reader.ts'), 'export const reader = true\n');
  const add = spawnSync('git', ['add', 'apps/web'], { cwd: worktree, encoding: 'utf8' });
  if (add.status !== 0) throw new Error(add.stderr || 'git add Web compiler fixture failed');
  const commit = spawnSync('git', ['commit', '-m', 'Prepare Web compiler recovery fixture'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  if (commit.status !== 0) throw new Error(commit.stderr || 'git commit Web compiler fixture failed');
}

function prepareConsumedWebRecovery(h: ReturnType<typeof harness>) {
  const task = h.tasks.dispatch(h.briefFile);
  prepareWebCompiler(task.worktree);
  const startedAt = new Date().toISOString();
  const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number): Attempt => ({
    taskId: task.id,
    attempt: number,
    state: 'pending',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt,
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${number}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(number)),
    auxiliaryProcesses: [],
    session: null,
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: null,
    result: '',
    blocker: null,
    approaches: [],
  }));
  const ref = { taskId: task.id, attempt: attempt.attempt };
  const result = 'Compiler input closure is unavailable for the last check-host typecheck. Source is retained.';
  h.store.updateAttempt(ref, (current) => {
    current.state = 'exited';
    current.endedAt = new Date(Date.parse(startedAt) + 1_000).toISOString();
    current.exitCode = 0;
    current.result = result;
    current.typingEvidencePending = { result, command: webCompiler };
  });
  h.store.updateTask(ref, (current) => {
    current.state = 'stopped';
  });
  const actor = { id: task.brief.manager, sessionId: 'web-manager-session' };
  h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  h.store.db.query('INSERT INTO manager_sessions VALUES (?,?)').run(
    actor.id,
    JSON.stringify({
      id: actor.id,
      kind: 'managed',
      engine: 'claude',
      status: 'running',
      threadId: actor.sessionId,
    }),
  );

  const budget = workerCheckBudgetDirectory(h.settings.stateDirectory, task.id, ref.attempt);
  const original = grantWorkerTypingRecovery({
    stateDirectory: h.settings.stateDirectory,
    database: h.store.db.filename,
    taskId: task.id,
    attempt: ref.attempt,
    worktree: task.worktree,
    command: webCompiler,
    actor,
  });
  mkdirSync(budget, { recursive: true });
  writeFileSync(
    join(budget, '1'),
    JSON.stringify({
      content: workerCheckHostContentTree(task.worktree),
      includedTypecheck: true,
      exitCode: 0,
      typingRequest: {
        physicalRunId: original.physicalRunId,
        command: webCompiler,
        localPrepared: [],
        capture: 'physical-command',
      },
      typingRecovery: {
        token: original.token,
        checkId: original.checkId,
        physicalRunId: original.physicalRunId,
      },
    }),
  );
  writeFileSync(join(budget, 'typing-recovery', `${original.token}.json`), JSON.stringify({ ...original, stamp: '1' }));
  h.store.updateAttempt(ref, (current) => {
    current.checks = [original.checkId];
  });
  return { task, ref, actor, budget, original };
}

test('active typing recovery requires its consumed grant and exact running physical check', async () => {
  const h = harness();
  try {
    const { task, ref, actor, budget, original } = prepareConsumedWebRecovery(h);
    h.store.event(ref, 'typing-recovery-authorized', {
      actor,
      token: original.token,
      identity: original.identity,
      command: original.command,
      checkId: original.checkId,
    });
    const runner = processIdentity();
    if (!runner) throw new Error('typing recovery fixture has no runner identity');
    const resultPath = join(task.worktree, '.temp/goal/checks/results', `${original.checkId}.json`);
    const physicalPath = physicalHistoryPath(task.worktree, original.checkId, original.physicalRunId);
    const owner = { taskId: task.id, attempt: ref.attempt };
    const record = {
      version: 1,
      id: original.checkId,
      cwd: task.worktree,
      argv: webCompiler,
      ownership: owner,
      physicalRunId: original.physicalRunId,
      runnerHost: hostname(),
      runnerPid: runner.pid,
      runnerIdentity: runner,
      status: 'running',
    };
    const physical = {
      ...record,
      remoteExpected: false,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(dirname(resultPath), { recursive: true });
    mkdirSync(dirname(physicalPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify(record));
    writeFileSync(physicalPath, JSON.stringify(physical));

    expect(
      workerCheckHostActiveTypingRecovery({
        db: h.store.db,
        stateDirectory: h.settings.stateDirectory,
        taskId: task.id,
        worktree: task.worktree,
      }),
    ).toMatchObject({
      token: original.token,
      checkId: original.checkId,
      physicalRunId: original.physicalRunId,
      runnerIdentity: runner,
    });

    rmSync(physicalPath);
    expect(
      workerCheckHostActiveTypingRecovery({
        db: h.store.db,
        stateDirectory: h.settings.stateDirectory,
        taskId: task.id,
        worktree: task.worktree,
      }),
    ).toBeUndefined();
    writeFileSync(physicalPath, JSON.stringify(physical));

    writeFileSync(resultPath, JSON.stringify({ ...record, status: 'finished', exitCode: 0 }));
    expect(
      workerCheckHostActiveTypingRecovery({
        db: h.store.db,
        stateDirectory: h.settings.stateDirectory,
        taskId: task.id,
        worktree: task.worktree,
      }),
    ).toBeUndefined();

    writeFileSync(resultPath, JSON.stringify(record));
    const stampPath = join(budget, '1');
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as Record<string, unknown>;
    const consumed = stamp.typingRecovery as Record<string, unknown>;
    writeFileSync(stampPath, JSON.stringify({ ...stamp, typingRecovery: { ...consumed, token: randomUUID() } }));
    expect(
      workerCheckHostActiveTypingRecovery({
        db: h.store.db,
        stateDirectory: h.settings.stateDirectory,
        taskId: task.id,
        worktree: task.worktree,
      }),
    ).toBeUndefined();
  } finally {
    await h.disposeAsync();
  }
});

test('settled cleanup accepts only exact ownership and terminal local and remote custody', () => {
  const worktree = temporaryDirectory();
  const authorization = temporaryDirectory();
  try {
    const taskId = randomUUID();
    const checkId = randomUUID();
    const physicalRunId = randomUUID();
    writeVerifiedResultlessCleanupEvidence({
      worktree: worktree.path,
      stateDirectory: authorization.path,
      taskId,
      attempt: 1,
      checkId,
      physicalRunId,
      command: compiler,
    });
    const custody = () => workerCheckHostAttemptCheckCustody(worktree.path, taskId, 1, [checkId]);
    expect(custody()).toBe('terminal');
    expect(workerCheckHostAttemptHasResultlessCleanup(worktree.path, taskId, 1, [checkId], compiler)).toBe(true);
    expect(workerCheckHostAttemptHasResultlessCleanup(worktree.path, taskId, 1, [checkId], ['bun', 'test'])).toBe(
      false,
    );

    const resultPath = join(worktree.path, '.temp/goal/checks/results', `${checkId}.json`);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    writeFileSync(resultPath, JSON.stringify({ ...result, status: 'finished', exitCode: 0 }));
    expect(custody()).toBe('unknown');
    expect(workerCheckHostAttemptHasResultlessCleanup(worktree.path, taskId, 1, [checkId], compiler)).toBe(false);
    writeVerifiedResultlessCleanupEvidence({
      worktree: worktree.path,
      stateDirectory: authorization.path,
      taskId,
      attempt: 1,
      checkId,
      physicalRunId,
      command: compiler,
    });

    const cleanupPath = cleanupReceiptPath(worktree.path, checkId, physicalRunId);
    const cleanup = JSON.parse(readFileSync(cleanupPath, 'utf8'));
    cleanup.ownership.attempt = 2;
    writeFileSync(cleanupPath, JSON.stringify(cleanup));
    expect(custody()).toBe('unknown');
    writeVerifiedResultlessCleanupEvidence({
      worktree: worktree.path,
      stateDirectory: authorization.path,
      taskId,
      attempt: 1,
      checkId,
      physicalRunId,
      command: compiler,
    });

    const remotePath = remoteRunCustodyPath(worktree.path, physicalRunId);
    const remote = JSON.parse(readFileSync(remotePath, 'utf8'));
    remote.attempts[0].status = 'running';
    writeFileSync(remotePath, JSON.stringify(remote));
    expect(custody()).toBe('unknown');
    writeVerifiedResultlessCleanupEvidence({
      worktree: worktree.path,
      stateDirectory: authorization.path,
      taskId,
      attempt: 1,
      checkId,
      physicalRunId,
      command: compiler,
    });

    const historyPath = physicalHistoryPath(worktree.path, checkId, physicalRunId);
    const history = JSON.parse(readFileSync(historyPath, 'utf8'));
    history.terminalProof.local = false;
    writeFileSync(historyPath, JSON.stringify(history));
    expect(custody()).toBe('unknown');
  } finally {
    worktree.close();
    authorization.close();
  }
});

test('an unresolved consumed Web grant reports its check and foreign custody stably without another proof', async () => {
  const h = harness();
  try {
    const retained = prepareConsumedWebRecovery(h);
    writeVerifiedResultlessCleanupEvidence({
      worktree: retained.task.worktree,
      stateDirectory: h.settings.stateDirectory,
      taskId: randomUUID(),
      attempt: retained.ref.attempt,
      checkId: retained.original.checkId,
      physicalRunId: retained.original.physicalRunId,
      command: webCompiler,
    });
    const landing = { enqueue: (_value: unknown) => {} };
    const first = await recoverWorkerTyping(h.tasks, landing, retained.ref, retained.actor);
    const second = await recoverWorkerTyping(h.tasks, landing, retained.ref, retained.actor);
    if (!('result' in first) || !('result' in second))
      throw new Error('unresolved Web recovery lost its pending reason');

    expect(first).toMatchObject({ status: 'pending' });
    expect('proof' in first).toBe(false);
    expect(second).toMatchObject({ status: 'pending', result: first.result });
    expect(first.result).toContain(`check ${retained.original.checkId}`);
    expect(first.result).toContain(`physical run ${retained.original.physicalRunId}`);
    expect(first.result).toContain('custody of the same-attempt checks is unknown');
    expect(readdirSync(join(retained.budget, 'typing-recovery')).filter((file) => file.endsWith('.json'))).toHaveLength(
      1,
    );
    expect(h.store.attempt(retained.ref)).toMatchObject({
      result: expect.stringContaining('Compiler input closure is unavailable'),
      typingEvidencePending: { command: webCompiler },
      checks: [retained.original.checkId],
    });
    expect(h.store.task(retained.task.id)).toMatchObject({ currentAttempt: retained.ref.attempt, state: 'stopped' });
  } finally {
    await h.disposeAsync();
  }
});

test('verified cleanup for one consumed Web run authorizes only its existing single replacement', async () => {
  const h = harness();
  try {
    const retained = prepareConsumedWebRecovery(h);
    writeVerifiedResultlessCleanupEvidence({
      worktree: retained.task.worktree,
      stateDirectory: h.settings.stateDirectory,
      taskId: retained.task.id,
      attempt: retained.ref.attempt,
      checkId: retained.original.checkId,
      physicalRunId: retained.original.physicalRunId,
      command: webCompiler,
    });
    const landing = { enqueue: (_value: unknown) => {} };
    const first = await recoverWorkerTyping(h.tasks, landing, retained.ref, retained.actor);
    const firstProof = recoveryProof(first);
    const replay = await recoverWorkerTyping(h.tasks, landing, retained.ref, retained.actor);
    const replayProof = recoveryProof(replay);
    const grants = readdirSync(join(retained.budget, 'typing-recovery'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(retained.budget, 'typing-recovery', file), 'utf8')));

    expect(firstProof.commands[0]?.slice(-webCompiler.length)).toEqual(webCompiler);
    expect(firstProof.env[TYPING_RECOVERY_ENV]).not.toBe(retained.original.token);
    expect(replayProof.env[TYPING_RECOVERY_ENV]).toBe(firstProof.env[TYPING_RECOVERY_ENV]);
    expect(grants).toHaveLength(2);
    expect(grants.find((grant) => grant.replacementOf)).toMatchObject({
      replacementOf: retained.original.token,
      command: webCompiler,
    });
    expect(h.store.task(retained.task.id)).toMatchObject({ currentAttempt: retained.ref.attempt, state: 'stopped' });
    expect(h.store.attempt(retained.ref)).toMatchObject({
      typingEvidencePending: { command: webCompiler },
      checks: [retained.original.checkId],
    });
  } finally {
    await h.disposeAsync();
  }
});

test('authenticated typing-recover issues one replayable compiler-only grant after resultless remote cleanup', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    prepareKernelCompilerFixture(task.worktree, true);
    const startedAt = new Date().toISOString();
    const result = 'Compiler input closure is unavailable for the last check-host typecheck. Source is retained.';
    const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number): Attempt => ({
      taskId: task.id,
      attempt: number,
      state: 'pending',
      profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
      pool: 'fixture',
      tableVersion: 'fixture',
      experiment: null,
      startedAt,
      endedAt: null,
      process: null,
      driver: null,
      logPath: join(h.settings.stateDirectory, 'runs', task.id, `${number}.jsonl`),
      evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(number)),
      auxiliaryProcesses: [],
      session: null,
      fixRound: 0,
      consulted: false,
      previousFailure: null,
      failure: null,
      escalation: null,
      before: null,
      after: null,
      exitCode: null,
      result: '',
      blocker: null,
      approaches: [],
    }));
    const ref = { taskId: task.id, attempt: attempt.attempt };
    const stateDirectory = h.settings.stateDirectory;
    const budget = workerCheckBudgetDirectory(stateDirectory, task.id, ref.attempt);
    const actor = { id: task.brief.manager, sessionId: 'manager-session' };
    const grantInput = {
      stateDirectory,
      database: h.store.db.filename,
      taskId: task.id,
      attempt: ref.attempt,
      worktree: task.worktree,
      command: compiler,
      actor,
    };
    expect(() => grantWorkerTypingRecovery(grantInput, { requireResultlessCleanupReplacement: true })).toThrow(
      'Verified resultless cleanup has no consumed compiler grant to replace',
    );
    const original = grantWorkerTypingRecovery(grantInput);
    const checkId = original.checkId;
    const physicalRunId = original.physicalRunId;
    writeVerifiedResultlessCleanupEvidence({
      worktree: task.worktree,
      stateDirectory,
      taskId: task.id,
      attempt: ref.attempt,
      checkId,
      physicalRunId,
      command: compiler,
    });
    const sourceTree = workerCheckHostContentTree(task.worktree);
    writeFileSync(
      join(budget, '1'),
      JSON.stringify({
        content: sourceTree,
        includedTypecheck: true,
        typingRequest: { physicalRunId, command: compiler, localPrepared: [], capture: 'physical-command' },
        typingRecovery: { token: original.token, checkId: original.checkId, physicalRunId },
      }),
    );
    writeFileSync(
      join(budget, 'typing-recovery', `${original.token}.json`),
      JSON.stringify({ ...original, stamp: '1' }),
    );
    const resultRecordPath = join(task.worktree, '.temp/goal/checks/results', `${checkId}.json`);
    const preservedPaths = [
      resultRecordPath,
      join(task.worktree, '.temp/goal/checks/cancellations', `${checkId}.json`),
      join(task.worktree, '.temp/goal/checks/custody/cancelled', `${checkId}.json`),
      physicalHistoryPath(task.worktree, checkId, physicalRunId),
      cleanupReceiptPath(task.worktree, checkId, physicalRunId),
      remoteRunCustodyPath(task.worktree, physicalRunId),
    ];
    const preservedEvidence = preservedPaths.map((path) => readFileSync(path, 'utf8'));
    h.store.updateAttempt(ref, (current) => {
      current.state = 'exited';
      current.endedAt = new Date(Date.parse(startedAt) + 1_000).toISOString();
      current.exitCode = 0;
      current.result = result;
      current.checks = [original.checkId];
      current.typingEvidencePending = { result, command: compiler };
    });
    h.store.updateTask(ref, (current) => {
      current.state = 'stopped';
    });
    h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY,state TEXT NOT NULL)');
    h.store.db.query('INSERT INTO manager_sessions VALUES (?,?)').run(
      actor.id,
      JSON.stringify({
        id: actor.id,
        kind: 'managed',
        engine: 'claude',
        status: 'running',
        threadId: actor.sessionId,
      }),
    );

    const landing = { enqueue: (_value: unknown) => {} };
    const unauthenticated = await recoverWorkerTyping(h.tasks, landing, ref);
    expect(unauthenticated).toMatchObject({ status: 'pending' });
    expect('proof' in unauthenticated).toBe(false);
    expect(readdirSync(join(budget, 'typing-recovery')).filter((file) => file.endsWith('.json'))).toHaveLength(1);

    const sourcePath = join(task.worktree, 'services/kernel/src/index.ts');
    const originalSource = readFileSync(sourcePath, 'utf8');
    writeFileSync(sourcePath, `${originalSource}export const changed = true;\n`);
    await expect(recoverWorkerTyping(h.tasks, landing, ref, actor)).rejects.toThrow(
      'Typing recovery source or compiler command changed after resultless cleanup',
    );
    writeFileSync(sourcePath, originalSource);

    const recovered = await recoverWorkerTyping(h.tasks, landing, ref, actor);
    expect(recovered).toMatchObject({ status: 'pending', proof: { cwd: task.worktree } });
    if (!('proof' in recovered)) throw new Error('authenticated recovery did not issue a compiler proof');
    expect(recovered.proof.commands).toHaveLength(1);
    expect(recovered.proof.commands[0]?.slice(-compiler.length)).toEqual(compiler);
    expect(recovered.proof.env[TYPING_RECOVERY_ENV]).toMatch(/^[0-9a-f-]{36}$/);
    expect(preservedPaths.map((path) => readFileSync(path, 'utf8'))).toEqual(preservedEvidence);
    const grants = readdirSync(join(budget, 'typing-recovery'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(budget, 'typing-recovery', file), 'utf8')));
    expect(grants).toHaveLength(2);
    expect(grants.find((grant) => grant.replacementOf)).toMatchObject({
      replacementOf: original.token,
      command: compiler,
    });
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: ref.attempt, state: 'stopped' });
    expect(h.store.attempt(ref)).toMatchObject({
      result,
      checks: [original.checkId],
      typingEvidencePending: { command: compiler },
    });

    const replayed = await recoverWorkerTyping(h.tasks, landing, ref, actor);
    if (!('proof' in replayed)) throw new Error('replayed authenticated recovery lost its compiler proof');
    expect(replayed.proof.env[TYPING_RECOVERY_ENV]).toBe(recovered.proof.env[TYPING_RECOVERY_ENV]);
    expect(readdirSync(join(budget, 'typing-recovery')).filter((file) => file.endsWith('.json'))).toHaveLength(2);
    expect(h.store.task(task.id).currentAttempt).toBe(ref.attempt);

    h.store.updateTask(ref, (current) => {
      current.state = 'cancelled';
    });
    await expect(recoverWorkerTyping(h.tasks, landing, ref, actor)).rejects.toThrow(
      'completed ordinary source with pending compiler evidence',
    );
    h.store.updateTask(ref, (current) => {
      current.state = 'stopped';
    });
    h.store.nextAttempt(ref, (number) => ({
      ...attempt,
      attempt: number,
      startedAt: new Date().toISOString(),
      logPath: join(h.settings.stateDirectory, 'runs', task.id, `${number}.jsonl`),
      evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(number)),
    }));
    await expect(recoverWorkerTyping(h.tasks, landing, ref, actor)).rejects.toThrow();
    expect(readdirSync(join(budget, 'typing-recovery')).filter((file) => file.endsWith('.json'))).toHaveLength(2);
  } finally {
    await h.disposeAsync();
  }
});
