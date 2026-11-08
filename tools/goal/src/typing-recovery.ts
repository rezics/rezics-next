import { join } from 'node:path';
import { isKnownTypingCompiler } from './worker-check-typing-inputs.ts';
import type { AttemptRef, LandingQueue } from './contracts.ts';
import { acquireDirectoryLease } from './lease.ts';
import { sameProcess } from './process.ts';
import { backlogManagerActor, type AuthenticatedManager } from './priority-authority.ts';
import { settle } from './settle.ts';
import type { WorkerTasks } from './tasks.ts';
import {
  expandCheckCommands,
  grantWorkerTypingRecovery,
  TYPING_RECOVERY_ENV,
  isTypecheckCommand,
  isTypingEvidenceUnavailableResult,
  workerCheckBudgetDirectory,
  workerCheckHostBudgetLimit,
  workerCheckHostTypingSettlement,
} from './worker-check-budget.ts';

/** Reconcile completed source under its original attempt; this boundary never invokes a model. */
export async function recoverWorkerTyping(
  tasks: WorkerTasks,
  landing: LandingQueue,
  ref: AttemptRef,
  actor?: AuthenticatedManager | null,
  afterSettle: () => Promise<void> = async () => {},
) {
  const { store, settings } = tasks;
  const lease = acquireDirectoryLease(join(settings.stateDirectory, 'leases', ref.taskId), settings.policy?.leases);
  try {
    store.assertCurrent(ref);
    const task = store.task(ref.taskId);
    let authority: AuthenticatedManager | undefined;
    if (actor !== undefined) {
      const live = actor && backlogManagerActor(store.db, actor.id);
      if (
        !live ||
        live.sessionId !== actor?.sessionId ||
        ![task.brief.manager, settings.integration.operationsManager].includes(live.id)
      )
        throw new Error('typing recovery requires the authenticated owning or operations manager');
      authority = live;
    }
    if (task.state === 'landing') return { ...ref, status: 'landing' as const };
    const attempt = store.attempt(ref);
    if (
      task.brief.kind === 'verification' ||
      !['ready', 'running', 'stopped'].includes(task.state) ||
      attempt.state !== 'exited' ||
      (attempt.process && sameProcess(attempt.process)) ||
      attempt.terminationIntent ||
      (!attempt.typingEvidencePending && !isTypingEvidenceUnavailableResult(attempt.result))
    )
      throw new Error('typing recovery requires completed ordinary source with pending compiler evidence');
    const directory = workerCheckBudgetDirectory(settings.stateDirectory, task.id, ref.attempt);
    const typing = workerCheckHostTypingSettlement({
      directory,
      worktree: task.worktree,
      limit: workerCheckHostBudgetLimit(task, ref.attempt),
    });
    if (store.retryIntent(ref)?.status === 'pending')
      store.updateRetryIntent(ref, (intent) => {
        intent.status = 'abandoned';
      });
    if (!typing.ok && typing.kind === 'typing-failure') {
      store.updateAttempt(ref, (current) => {
        delete current.typingEvidencePending;
        current.failureKind = 'tool';
        current.result = typing.result;
      });
      store.updateTask(ref, (current) => {
        current.state = 'stopped';
      });
      const record = store.record(ref);
      if (record) {
        record.outcome = 'stopped';
        store.putRecord(record);
      }
      store.event(ref, 'typing-evidence-failed', { result: typing.result });
      return { ...ref, status: 'typing-failure' as const, result: typing.result };
    }
    if (!typing.ok) {
      const original = typing.command ?? attempt.typingEvidencePending?.command ?? [];
      const commands = isKnownTypingCompiler(task.worktree, original)
        ? [original]
        : expandCheckCommands(original).filter(
            (command) => isTypecheckCommand(command) && (!authority || isKnownTypingCompiler(task.worktree, command)),
          );
      if (!commands.length) commands.push(['bun', 'scripts/typecheck.ts']);
      const grants = authority
        ? commands.map((command) =>
            grantWorkerTypingRecovery({
              stateDirectory: settings.stateDirectory,
              database: store.db.filename,
              taskId: task.id,
              attempt: ref.attempt,
              worktree: task.worktree,
              command,
              actor: authority!,
            }),
          )
        : [];
      for (const grant of grants)
        store.event(ref, 'typing-recovery-authorized', {
          actor: grant.actor,
          token: grant.token,
          identity: grant.identity,
          command: grant.command,
          checkId: grant.checkId,
        });
      store.updateTask(ref, (current) => {
        current.state = 'stopped';
      });
      return {
        ...ref,
        status: 'pending' as const,
        result: typing.result,
        proof: {
          cwd: task.worktree,
          env: {
            GOAL_TASK_ID: task.id,
            GOAL_ATTEMPT: String(ref.attempt),
            GOAL_WORKER_CHECK_BUDGET: String(workerCheckHostBudgetLimit(task, ref.attempt)),
            GOAL_WORKER_CHECK_BUDGET_DIR: directory,
            ...(grants.length === 1 ? { [TYPING_RECOVERY_ENV]: grants[0]!.token } : {}),
          },
          commands: commands.map((command, index) => [
            ...(grants.length > 1 ? ['env', `${TYPING_RECOVERY_ENV}=${grants[index]!.token}`] : []),
            ...(grants.length ? [process.execPath] : ['bun']),
            join(settings.mainCheckout, 'scripts/worker-check.ts'),
            '--run',
            '--',
            ...command,
          ]),
        },
      };
    }
    store.event(ref, 'typing-evidence-recovery', {
      actor: actor ?? { kind: 'controller' },
      previousResult: attempt.result,
    });
    await settle(
      tasks,
      { attempt, exited: Promise.resolve({ code: attempt.exitCode ?? 0, signal: null }) },
      landing,
      afterSettle,
    );
    return { ...ref, status: store.task(task.id).state === 'landing' ? ('landing' as const) : ('pending' as const) };
  } finally {
    lease.release();
  }
}
