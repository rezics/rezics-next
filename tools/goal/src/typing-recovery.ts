import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isKnownTypingCompiler, resolveTypingCompilerCommand } from './worker-check-typing-inputs.ts';
import type { AttemptRef, LandingQueue } from './contracts.ts';
import { acquireDirectoryLease } from './lease.ts';
import { sameProcess } from './process.ts';
import { backlogManagerActor, type AuthenticatedManager } from './priority-authority.ts';
import { readMeasurement } from './records.ts';
import { settle } from './settle.ts';
import type { WithdrawnTypingRecoveryOrigin } from './store.ts';
import type { WorkerTasks } from './tasks.ts';
import {
  expandCheckCommands,
  grantWorkerTypingRecovery,
  TYPING_RECOVERY_ENV,
  isTypecheckCommand,
  isTypingEvidenceUnavailableResult,
  workerCheckBudgetDirectory,
  workerCheckHostBudgetLimit,
  workerCheckHostAttemptCheckCustody,
  workerCheckHostHasDirectKernelTypingRun,
  workerCheckHostTypingCheckIds,
  workerCheckHostHasTypecheckRun,
  workerCheckHostTypingSettlement,
  workerCheckHostTypingReceiptMatches,
  workerCheckHostStaleTypingFailureSelection,
  workerCheckHostBudgetRefusalReport,
  workerCheckHostWithdrawnLegacyTypingCheckMatchesAttempt,
  workerCheckHostWithdrawnRetryIsRecoverable,
} from './worker-check-budget.ts';

const WITHDRAWN_WEB_COMPILER = ['bun', 'run', '--cwd', 'apps/web', 'typecheck'];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function refusalNamesSourceCommit(report: string, sourceCommit: unknown): sourceCommit is string {
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit)) return false;
  return (report.match(/[0-9a-f]{10,40}/gi) ?? []).some((reference) =>
    sourceCommit.startsWith(reference.toLowerCase()),
  );
}

function parsedObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function originalBudgetRefusal(
  tasks: WorkerTasks,
  attempt: ReturnType<WorkerTasks['store']['attempt']>,
  sourceCommit: unknown,
): string | undefined {
  const report = readMeasurement(attempt, { policy: tasks.store.policy }).result;
  if (!workerCheckHostBudgetRefusalReport(report) || !refusalNamesSourceCommit(report, sourceCommit)) return;
  return report;
}

function eventActorIsAllowed(
  body: Record<string, unknown>,
  task: ReturnType<WorkerTasks['store']['task']>,
  operationsManager: string,
): boolean {
  const actor = body.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return false;
  const value = actor as { id?: unknown; sessionId?: unknown };
  return (
    typeof value.id === 'string' &&
    [task.brief.manager, operationsManager].includes(value.id) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0
  );
}

function hasRetainedOverwrittenOrigin(events: readonly { kind: string; body: string }[]): boolean {
  return events.some(
    (event) =>
      event.kind === 'typing-recovery-authorized' &&
      event.body.includes('"withdrawnBudgetOrigin"'),
  );
}

function validateStoredOverwrittenOrigin(input: {
  tasks: WorkerTasks;
  events: readonly { kind: string; body: string }[];
  task: ReturnType<WorkerTasks['store']['task']>;
  attempt: ReturnType<WorkerTasks['store']['attempt']>;
  result: string;
  sourceCommit: unknown;
  directory: string;
}): { report: string; origin: WithdrawnTypingRecoveryOrigin } | undefined {
  const event = input.events.findLast(
    (entry) => entry.kind === 'typing-recovery-authorized' && entry.body.includes('"withdrawnBudgetOrigin"'),
  );
  if (!event) return;
  const body = parsedObject(event.body);
  const origin = body?.withdrawnBudgetOrigin as WithdrawnTypingRecoveryOrigin | undefined;
  if (
    !body ||
    body.recoveryKind !== 'withdrawn-budget-stop' ||
    JSON.stringify(body.command) !== JSON.stringify(WITHDRAWN_WEB_COMPILER) ||
    !eventActorIsAllowed(body, input.task, input.tasks.settings.integration.operationsManager) ||
    !origin ||
    origin.version !== 1 ||
    !/^[0-9a-f]{40}$/.test(origin.sourceCommit) ||
    !/^[0-9a-f]{64}$/.test(origin.reportSha256) ||
    !/^[0-9a-f]{64}$/.test(origin.failureSha256) ||
    !/^[1-9]\d*$/.test(origin.failureStamp) ||
    origin.sourceCommit !== input.sourceCommit ||
    origin.failureSha256 !== sha256(input.result)
  )
    return;
  const selection = workerCheckHostStaleTypingFailureSelection({
    directory: input.directory,
    worktree: input.task.worktree,
    result: input.result,
    stamp: origin.failureStamp,
  });
  if (
    !selection ||
    JSON.stringify(selection.command) !== JSON.stringify(WITHDRAWN_WEB_COMPILER) ||
    !workerCheckHostWithdrawnLegacyTypingCheckMatchesAttempt(
      input.task.worktree,
      input.task.id,
      input.attempt.attempt,
      selection.physicalRunId,
      selection.command,
      selection.exitCode,
    )
  )
    return;
  const report = originalBudgetRefusal(input.tasks, input.attempt, origin.sourceCommit);
  if (!report || sha256(report) !== origin.reportSha256) return;
  return { report, origin };
}

function reconstructOverwrittenOrigin(input: {
  tasks: WorkerTasks;
  events: readonly { kind: string; body: string }[];
  task: ReturnType<WorkerTasks['store']['task']>;
  attempt: ReturnType<WorkerTasks['store']['attempt']>;
  result: string;
  sourceCommit: unknown;
  directory: string;
}): { report: string; origin: WithdrawnTypingRecoveryOrigin } | undefined {
  if (
    input.events.some((event) => event.kind === 'typing-recovery-authorized' || event.kind === 'typing-evidence-recovery')
  )
    return;
  const failure = input.events.findLast((event) => event.kind === 'typing-evidence-failed');
  const body = failure ? parsedObject(failure.body) : undefined;
  if (
    !body ||
    Object.keys(body).sort().join(',') !== 'actor,recoveryKind' ||
    body.recoveryKind !== 'withdrawn-budget-stop' ||
    !eventActorIsAllowed(body, input.task, input.tasks.settings.integration.operationsManager)
  )
    return;
  const selection = workerCheckHostStaleTypingFailureSelection({
    directory: input.directory,
    worktree: input.task.worktree,
    result: input.result,
  });
  if (
    !selection ||
    JSON.stringify(selection.command) !== JSON.stringify(WITHDRAWN_WEB_COMPILER) ||
    !workerCheckHostWithdrawnLegacyTypingCheckMatchesAttempt(
      input.task.worktree,
      input.task.id,
      input.attempt.attempt,
      selection.physicalRunId,
      selection.command,
      selection.exitCode,
    )
  )
    return;
  const report = originalBudgetRefusal(input.tasks, input.attempt, input.sourceCommit);
  if (!report || typeof input.sourceCommit !== 'string') return;
  return {
    report,
    origin: {
      version: 1,
      sourceCommit: input.sourceCommit,
      reportSha256: sha256(report),
      failureSha256: sha256(input.result),
      failureStamp: selection.stamp,
    },
  };
}

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
    const task = store.task(ref.taskId);
    if (task.currentAttempt !== ref.attempt) store.assertCurrent(ref);
    if (task.state === 'landing') {
      store.assertCurrent(ref);
      return { ...ref, status: 'landing' as const };
    }
    const attempt = store.attempt(ref);
    const retry = store.retryIntent(ref);
    const events = store.events(ref.taskId, ref.attempt);
    const progressEvent = events.findLast((event) => event.kind === 'attempt-progress');
    let progress: { endHead?: unknown; uncommitted?: unknown } | undefined;
    try {
      progress = progressEvent ? (JSON.parse(progressEvent.body) as typeof progress) : undefined;
    } catch {
      progress = undefined;
    }
    const directory = workerCheckBudgetDirectory(settings.stateDirectory, task.id, ref.attempt);
    let eligibilityAttempt = attempt;
    let withdrawnOrigin: WithdrawnTypingRecoveryOrigin | undefined;
    if (
      !workerCheckHostBudgetRefusalReport(attempt.result) &&
      typeof attempt.result === 'string' &&
      attempt.result.startsWith('Last check-host run failed its typecheck.')
    ) {
      const recoveredOrigin = hasRetainedOverwrittenOrigin(events)
        ? validateStoredOverwrittenOrigin({
            tasks,
            events,
            task,
            attempt,
            result: attempt.result,
            sourceCommit: progress?.endHead,
            directory,
          })
        : reconstructOverwrittenOrigin({
            tasks,
            events,
            task,
            attempt,
            result: attempt.result,
            sourceCommit: progress?.endHead,
            directory,
          });
      if (recoveredOrigin) {
        eligibilityAttempt = { ...attempt, result: recoveredOrigin.report };
        withdrawnOrigin = recoveredOrigin.origin;
      }
    }
    const withdrawnRetry = workerCheckHostWithdrawnRetryIsRecoverable({
      task,
      attempt: eligibilityAttempt,
      ...(retry ? { retry } : {}),
      ...(progress ? { progress } : {}),
    });
    const ordinaryPending =
      ['ready', 'running', 'stopped'].includes(task.state) &&
      attempt.state === 'exited' &&
      !(attempt.process && sameProcess(attempt.process)) &&
      !attempt.terminationIntent &&
      (attempt.typingEvidencePending !== undefined || isTypingEvidenceUnavailableResult(attempt.result));
    if (task.brief.kind === 'verification' || (!ordinaryPending && !withdrawnRetry)) {
      if (
        !withdrawnRetry &&
        attempt.state === 'stopped' &&
        task.state === 'stopped' &&
        (attempt.typingEvidencePending !== undefined || isTypingEvidenceUnavailableResult(attempt.result))
      )
        throw new Error('typing recovery requires completed ordinary source with pending compiler evidence');
      store.assertCurrent(ref);
      throw new Error('typing recovery requires completed ordinary source with pending compiler evidence');
    }
    if (!withdrawnRetry) store.assertCurrent(ref);
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
    if (withdrawnRetry && !authority)
      throw new Error('withdrawn retry compiler recovery requires authenticated owner or operations authority');
    const typing = workerCheckHostTypingSettlement({
      directory,
      worktree: task.worktree,
      limit: workerCheckHostBudgetLimit(task, ref.attempt),
    });
    if (
      workerCheckHostHasDirectKernelTypingRun(directory, task.worktree) &&
      workerCheckHostAttemptCheckCustody(
        task.worktree,
        task.id,
        ref.attempt,
        workerCheckHostTypingCheckIds(directory, attempt.checks ?? []),
      ) !== 'terminal'
    )
      return {
        ...ref,
        status: 'pending' as const,
        result:
          'Retained Kernel compiler evidence is waiting for terminal custody of every same-attempt check. Existing check ownership stays fenced; no additional compiler run was authorized.',
      };
    if (store.retryIntent(ref)?.status === 'pending')
      store.updateRetryIntent(ref, (intent) => {
        intent.status = 'abandoned';
      });
    if (!typing.ok && typing.kind === 'typing-failure') {
      if (withdrawnRetry) {
        store.recordWithdrawnTypingRecoveryFailure(ref, attempt.result, typing.result, {
          actor: authority,
          recoveryKind: 'withdrawn-budget-stop',
        });
        return { ...ref, status: 'typing-failure' as const, result: typing.result };
      }
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
    const webCompiler = WITHDRAWN_WEB_COMPILER;
    const hasWebReceipt =
      typing.ok &&
      workerCheckHostHasTypecheckRun(directory) &&
      workerCheckHostTypingReceiptMatches(directory, webCompiler);
    if (withdrawnRetry && hasWebReceipt) {
      store.beginWithdrawnTypingRecoverySettlement(ref, attempt.result, webCompiler, {
        actor: authority,
        previousResult: attempt.result,
        recoveryKind: 'withdrawn-budget-stop',
        compilerCommand: webCompiler,
      });
      await settle(
        tasks,
        { attempt, exited: Promise.resolve({ code: attempt.exitCode ?? 0, signal: null }) },
        landing,
        afterSettle,
        { withdrawnBudgetRecovery: { previousResult: attempt.result, command: webCompiler } },
      );
      return {
        ...ref,
        status: store.task(task.id).state === 'landing' ? ('landing' as const) : ('pending' as const),
      };
    }
    if (!typing.ok || (withdrawnRetry && !hasWebReceipt)) {
      const pendingResult = typing.ok
        ? 'Compiler evidence for the retained Web source is missing; only the installed Web typecheck is authorized.'
        : typing.result;
      const original = (!typing.ok ? typing.command : undefined) ?? attempt.typingEvidencePending?.command ?? [];
      const expanded = expandCheckCommands(original);
      const resolvedWebCompiler = resolveTypingCompilerCommand(task.worktree, webCompiler);
      if (withdrawnRetry && !resolvedWebCompiler)
        throw new Error('Withdrawn retry recovery requires the installed owning Web typecheck');
      const commands = withdrawnRetry
        ? [resolvedWebCompiler!]
        : expanded
            .map((command) => resolveTypingCompilerCommand(task.worktree, command) ?? command)
            .filter(
              (command) => isTypecheckCommand(command) && (!authority || isKnownTypingCompiler(task.worktree, command)),
            );
      const workspaceScoped = expanded.some(
        (command) =>
          (command[0] === 'bun' || command[0]?.endsWith('/bun')) &&
          command.length === 5 &&
          command[4] === 'typecheck' &&
          ((command[1] === 'run' && command[2] === '--cwd') || (command[1] === '--cwd' && command[3] === 'run')),
      );
      if (!commands.length && !workspaceScoped) commands.push(['bun', 'scripts/typecheck.ts']);
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
              ...(withdrawnRetry ? { recoveryKind: 'withdrawn-budget-stop' as const } : {}),
            }),
          )
        : [];
      if (withdrawnRetry && grants.length === 1) {
        const grant = grants[0]!;
        store.recordWithdrawnTypingRecoveryAuthorization(
          ref,
          attempt.result,
          { result: pendingResult, command: grant.command },
          {
            actor: grant.actor,
            token: grant.token,
            identity: grant.identity,
            command: grant.command,
            checkId: grant.checkId,
            recoveryKind: 'withdrawn-budget-stop',
          },
          withdrawnOrigin,
        );
      } else {
        for (const grant of grants)
          store.event(ref, 'typing-recovery-authorized', {
            actor: grant.actor,
            token: grant.token,
            identity: grant.identity,
            command: grant.command,
            checkId: grant.checkId,
            ...(grant.recoveryKind ? { recoveryKind: grant.recoveryKind } : {}),
          });
        store.updateTask(ref, (current) => {
          current.state = 'stopped';
        });
      }
      return {
        ...ref,
        status: 'pending' as const,
        result: pendingResult,
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
    if (withdrawnRetry)
      store.beginWithdrawnTypingRecoverySettlement(ref, attempt.result, webCompiler, {
        actor: actor ?? { kind: 'controller' },
        previousResult: attempt.result,
        recoveryKind: 'withdrawn-budget-stop',
        compilerCommand: webCompiler,
      });
    else
      store.event(ref, 'typing-evidence-recovery', {
        actor: actor ?? { kind: 'controller' },
        previousResult: attempt.result,
      });
    await settle(
      tasks,
      { attempt, exited: Promise.resolve({ code: attempt.exitCode ?? 0, signal: null }) },
      landing,
      afterSettle,
      withdrawnRetry
        ? { withdrawnBudgetRecovery: { previousResult: attempt.result, command: webCompiler } }
        : undefined,
    );
    return { ...ref, status: store.task(task.id).state === 'landing' ? ('landing' as const) : ('pending' as const) };
  } finally {
    lease.release();
  }
}
