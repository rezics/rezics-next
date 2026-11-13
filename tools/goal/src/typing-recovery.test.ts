import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupReceiptPath, physicalHistoryPath, remoteRunCustodyPath } from '../../../scripts/check-custody.ts';
import { recoverWorkerTyping } from './typing-recovery.ts';
import {
  grantWorkerTypingRecovery,
  TYPING_RECOVERY_ENV,
  workerCheckBudgetDirectory,
  workerCheckHostAttemptCheckCustody,
  workerCheckHostAttemptHasResultlessCleanup,
  workerCheckHostContentTree,
} from './worker-check-budget.ts';
import type { Attempt } from './types.ts';
import {
  harness,
  prepareKernelCompilerFixture,
  temporaryDirectory,
  writeVerifiedResultlessCleanupEvidence,
} from './test-support.ts';

const compiler = ['bun', 'services/kernel/scripts/typecheck.ts'];

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
    h.store.db
      .query('INSERT INTO manager_sessions VALUES (?,?)')
      .run(
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
