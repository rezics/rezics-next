import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  hasKernelClientOutputIntent,
  isKernelClientEmitterIntent,
  isKernelClientTypingPipelineIntent,
  isKnownTypingCompiler,
  resolveTypingCompilerCommand,
} from './worker-check-typing-inputs.ts';
import type { AttemptRef, LandingQueue } from './contracts.ts';
import { branchHead } from './attempt-progress.ts';
import { capacityWaiters } from './launch-capacity.ts';
import { acquireDirectoryLease } from './lease.ts';
import { sameProcess } from './process.ts';
import { backlogManagerActor, type AuthenticatedManager } from './priority-authority.ts';
import { readMeasurement } from './records.ts';
import { sourceOnlyCompletionEligible } from './prompts.ts';
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
  workerCheckHostAttemptHasResultlessCleanup,
  workerCheckHostConsumedTypingRecovery,
  workerCheckHostHasRetainedKernelTypingRun,
  workerCheckHostTypingCheckIds,
  workerCheckHostHasTypecheckRun,
  workerCheckHostTypingSettlement,
  workerCheckHostTypingReceiptMatches,
  workerCheckHostStaleTypingFailureSelection,
  workerCheckHostBudgetRefusalReport,
  workerCheckHostWithdrawnLegacyTypingCheckMatchesAttempt,
  workerCheckHostWithdrawnRetryIsRecoverable,
  workerCheckHostTerminalSourceRepair,
} from './worker-check-budget.ts';

const WITHDRAWN_WEB_COMPILER = ['bun', 'run', '--cwd', 'apps/web', 'typecheck'];

/**
 * Release a queued source repair through normal retry admission only for a retained compiler failure, the exact
 * supported setup defect, or an accepted source-only amendment with unavailable compiler evidence. Every check must
 * have terminal custody. Stopped attempts keep their stop proof; exited attempts keep their captured source head.
 */
export type TypingRetryReconciliationOutcome = 'admitted' | 'source-amendment-compiler-hold' | 'unresolved';

export function reconcileQueuedTypingFailureRetryOutcome(
  tasks: WorkerTasks,
  ref: AttemptRef,
): TypingRetryReconciliationOutcome {
  const { store, settings } = tasks;
  const lease = acquireDirectoryLease(join(settings.stateDirectory, 'leases', ref.taskId), settings.policy?.leases);
  try {
    const task = store.task(ref.taskId);
    if (task.currentAttempt !== ref.attempt || task.state !== 'ready' || task.brief.kind === 'verification')
      return 'unresolved';
    const attempt = store.attempt(ref);
    const retry = store.retryIntent(ref);
    const pendingEvidence =
      attempt.typingEvidencePending !== undefined || isTypingEvidenceUnavailableResult(attempt.result);
    if (
      !['stopped', 'exited'].includes(attempt.state) ||
      !pendingEvidence ||
      !retry ||
      (retry.status !== 'pending' && retry.status !== 'started') ||
      (retry.status === 'pending' ? retry.nextAttempt !== undefined : retry.nextAttempt !== ref.attempt)
    )
      return 'unresolved';

    const retryQueuedAt = Date.parse(retry.queuedAt ?? '');
    const events = store.events(task.id);
    const attemptEvents = store.events(task.id, ref.attempt);
    let validStoppedRetry = false;
    let validExitedAmendment = false;
    let acceptedSourceOnlyAmendment = false;
    let exitedProgressEventRecorded = false;
    let exitedCapturedHeadMatches = false;
    let exitedCurrentHead: string | null = null;
    if (attempt.state === 'stopped') {
      const stop = attempt.terminationIntent;
      const endedAt = Date.parse(attempt.endedAt ?? '');
      const stopRequestedAt = Date.parse(stop?.requestedAt ?? '');
      const stopSettledAt = Date.parse(stop?.settledAt ?? '');
      validStoppedRetry = Boolean(
        stop &&
        stop.operation === 'stop' &&
        stop.state === 'complete' &&
        stop.processIdentity === 'known' &&
        stop.settledAt &&
        attempt.endedAt &&
        stop.process &&
        attempt.process &&
        JSON.stringify(stop.process) === JSON.stringify(attempt.process) &&
        JSON.stringify(stop.auxiliaryProcesses) === JSON.stringify(attempt.auxiliaryProcesses ?? []) &&
        [endedAt, stopRequestedAt, stopSettledAt, retryQueuedAt].every(Number.isFinite) &&
        stopRequestedAt > endedAt &&
        stopSettledAt >= stopRequestedAt &&
        retryQueuedAt > stopSettledAt &&
        !sameProcess(stop.process) &&
        (attempt.driver === null || !sameProcess(attempt.driver)) &&
        [...(attempt.auxiliaryProcesses ?? []), ...stop.auxiliaryProcesses].every((identity) => !sameProcess(identity)),
      );
    } else if (attempt.state === 'exited') {
      const endedAt = Date.parse(attempt.endedAt ?? '');
      const amendment = task.pendingBriefChange;
      const acceptedAmendment = store.newestPendingBriefProposal(task.id);
      const acceptedAt = Date.parse(acceptedAmendment?.createdAt ?? '');
      const progressEvent = attemptEvents.findLast((event) => event.kind === 'attempt-progress');
      exitedProgressEventRecorded = progressEvent !== undefined;
      let capturedHead: unknown;
      try {
        const progress: unknown = progressEvent ? JSON.parse(progressEvent.body) : undefined;
        capturedHead =
          progress && typeof progress === 'object' ? (progress as { endHead?: unknown }).endHead : undefined;
      } catch {
        capturedHead = undefined;
      }
      const currentHead = branchHead(task);
      exitedCurrentHead = currentHead;
      exitedCapturedHeadMatches = Boolean(
        typeof capturedHead === 'string' &&
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(capturedHead) &&
        currentHead === capturedHead,
      );
      validExitedAmendment = Boolean(
        attempt.failureKind === null &&
        attempt.exitCode === 0 &&
        !attempt.terminationIntent &&
        attempt.endedAt &&
        Number.isFinite(endedAt) &&
        Number.isFinite(retryQueuedAt) &&
        retryQueuedAt > endedAt &&
        Number.isFinite(acceptedAt) &&
        acceptedAt > endedAt &&
        acceptedAt <= retryQueuedAt &&
        Array.isArray(attempt.typingEvidencePending?.command) &&
        attempt.typingEvidencePending.command.length > 0 &&
        amendment &&
        acceptedAmendment &&
        acceptedAmendment.writtenForAttempt === ref.attempt &&
        briefHash(acceptedAmendment.markdown) === acceptedAmendment.newBriefHash &&
        acceptedAmendment.previousBriefHash === amendment.previousBriefHash &&
        acceptedAmendment.newBriefHash === amendment.newBriefHash &&
        /^[a-f0-9]{64}$/.test(amendment.previousBriefHash) &&
        /^[a-f0-9]{64}$/.test(amendment.newBriefHash) &&
        amendment.previousBriefHash !== amendment.newBriefHash &&
        amendment.newBriefHash === briefHash(task.brief.markdown) &&
        (exitedProgressEventRecorded ? exitedCapturedHeadMatches : exitedCurrentHead !== null) &&
        ![attempt.process, attempt.driver, ...(attempt.auxiliaryProcesses ?? [])].some(
          (identity) => identity !== null && sameProcess(identity),
        ),
      );
      acceptedSourceOnlyAmendment =
        validExitedAmendment &&
        sourceOnlyCompletionEligible({ task, stateDirectory: settings.stateDirectory, policy: settings.policy });
    }
    if (!validStoppedRetry && !validExitedAmendment) return 'unresolved';

    if (
      events.some((event) => event.attempt === ref.attempt && event.kind === 'landing-requested') ||
      events.some((event) => {
        if (event.kind !== 'worker-run-started') return false;
        const at = Date.parse(event.at);
        return !Number.isFinite(at) || at >= retryQueuedAt;
      }) ||
      store.attempts(task.id).some((candidate) => candidate.attempt > ref.attempt) ||
      capacityWaiters(settings.stateDirectory, store).has(task.id)
    )
      return 'unresolved';

    const proofInput = {
      directory: workerCheckBudgetDirectory(settings.stateDirectory, task.id, ref.attempt),
      worktree: task.worktree,
      limit: workerCheckHostBudgetLimit(task, ref.attempt),
      taskId: task.id,
      attempt: ref.attempt,
      checkIds: attempt.checks ?? [],
      ...(attempt.typingEvidencePending?.command ? { pendingCommand: attempt.typingEvidencePending.command } : {}),
      ...(acceptedSourceOnlyAmendment ? { allowUnavailableSourceAmendment: true } : {}),
    };
    if (!workerCheckHostTerminalSourceRepair(proofInput)) {
      const settlement = workerCheckHostTypingSettlement(proofInput);
      if (
        acceptedSourceOnlyAmendment &&
        attempt.typingEvidencePending?.command &&
        !settlement.ok &&
        settlement.kind === 'evidence-unavailable' &&
        JSON.stringify(attempt.typingEvidencePending.command) === JSON.stringify(settlement.command) &&
        workerCheckHostAttemptCheckCustody(task.worktree, task.id, ref.attempt, attempt.checks ?? []) === 'unknown'
      )
        return 'source-amendment-compiler-hold';
      return 'unresolved';
    }

    if (retry.status === 'started')
      store.updateRetryIntent(ref, (current) => {
        current.status = 'pending';
        delete current.nextAttempt;
      });
    return 'admitted';
  } finally {
    lease.release();
  }
}

export function reconcileQueuedTypingFailureRetry(tasks: WorkerTasks, ref: AttemptRef): boolean {
  return reconcileQueuedTypingFailureRetryOutcome(tasks, ref) === 'admitted';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function briefHash(markdown: string): string {
  return sha256(markdown.replace(/\r\n?/g, '\n').trimEnd());
}

/** An accepted source amendment keeps its retry queued while compiler or custody evidence remains unresolved. */
export function hasQueuedTypingSourceRepair(tasks: WorkerTasks, ref: AttemptRef): boolean {
  const { store } = tasks;
  const task = store.task(ref.taskId);
  const attempt = store.attempt(ref);
  const amendment = task.pendingBriefChange;
  const proposal = store.newestPendingBriefProposal(task.id);
  return Boolean(
    task.currentAttempt === ref.attempt &&
    task.state === 'ready' &&
    task.brief.kind !== 'verification' &&
    attempt.state === 'exited' &&
    (attempt.typingEvidencePending !== undefined || isTypingEvidenceUnavailableResult(attempt.result)) &&
    amendment &&
    proposal &&
    proposal.writtenForAttempt === ref.attempt &&
    proposal.previousBriefHash === amendment.previousBriefHash &&
    proposal.newBriefHash === amendment.newBriefHash &&
    /^[a-f0-9]{64}$/.test(amendment.previousBriefHash) &&
    /^[a-f0-9]{64}$/.test(amendment.newBriefHash) &&
    amendment.newBriefHash !== amendment.previousBriefHash &&
    briefHash(proposal.markdown) === proposal.newBriefHash &&
    proposal.newBriefHash === briefHash(task.brief.markdown),
  );
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
  operationsManager?: string,
): boolean {
  const actor = body.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return false;
  const value = actor as { id?: unknown; sessionId?: unknown };
  return (
    typeof value.id === 'string' &&
    (value.id === task.brief.manager || (operationsManager !== undefined && value.id === operationsManager)) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0
  );
}

function hasRetainedOverwrittenOrigin(events: readonly { kind: string; body: string }[]): boolean {
  return events.some(
    (event) => event.kind === 'typing-recovery-authorized' && event.body.includes('"withdrawnBudgetOrigin"'),
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
    input.events.some(
      (event) => event.kind === 'typing-recovery-authorized' || event.kind === 'typing-evidence-recovery',
    )
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
    let withdrawnOriginReport: string | undefined;
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
        withdrawnOriginReport = recoveredOrigin.report;
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
    const sourceOnly =
      !withdrawnRetry &&
      sourceOnlyCompletionEligible({ task, stateDirectory: settings.stateDirectory, policy: settings.policy });
    const typing = workerCheckHostTypingSettlement({
      directory,
      worktree: task.worktree,
      limit: workerCheckHostBudgetLimit(task, ref.attempt),
      inspectUnbudgeted: sourceOnly,
    });
    const checkIds = workerCheckHostTypingCheckIds(directory, attempt.checks ?? []);
    if (!typing.ok && typing.kind === 'evidence-unavailable' && sourceOnly) {
      if (workerCheckHostAttemptCheckCustody(task.worktree, task.id, ref.attempt, checkIds) !== 'terminal')
        return {
          ...ref,
          status: 'pending' as const,
          result:
            `${typing.result}\n` +
            'Compiler evidence can be deferred under source-only policy, but same-attempt check custody is not terminal. ' +
            `Keep check ids ${checkIds.join(', ') || '(none)'}, original owners and grants unchanged; no compiler command was issued.`,
        };
      if (retry?.status === 'pending')
        store.updateRetryIntent(ref, (intent) => {
          intent.status = 'abandoned';
        });
      await settle(
        tasks,
        { attempt, exited: Promise.resolve({ code: attempt.exitCode ?? 0, signal: null }) },
        landing,
        afterSettle,
      );
      return {
        ...ref,
        status: store.task(task.id).state === 'landing' ? ('landing' as const) : ('pending' as const),
      };
    }
    const pendingCommand = !typing.ok ? (typing.command ?? attempt.typingEvidencePending?.command) : undefined;
    const resolvedPendingCommand = pendingCommand
      ? resolveTypingCompilerCommand(task.worktree, pendingCommand)
      : undefined;
    const consumedWebRecovery =
      !typing.ok &&
      typing.kind === 'evidence-unavailable' &&
      JSON.stringify(resolvedPendingCommand) === JSON.stringify(WITHDRAWN_WEB_COMPILER)
        ? workerCheckHostConsumedTypingRecovery({
            directory,
            worktree: task.worktree,
            taskId: task.id,
            attempt: ref.attempt,
            checkIds,
            command: resolvedPendingCommand!,
          })
        : undefined;
    const retainedKernelRun = workerCheckHostHasRetainedKernelTypingRun(directory, task.worktree);
    const checkCustody =
      retainedKernelRun || consumedWebRecovery
        ? workerCheckHostAttemptCheckCustody(task.worktree, task.id, ref.attempt, checkIds)
        : 'terminal';
    if (retainedKernelRun && checkCustody !== 'terminal')
      return {
        ...ref,
        status: 'pending' as const,
        result:
          'Retained Kernel compiler evidence is waiting for terminal custody of every same-attempt check. Existing check ownership stays fenced; no additional compiler run was authorized.',
      };
    const verifiedWebCleanup = Boolean(
      consumedWebRecovery && checkCustody === 'terminal' && consumedWebRecovery.resultlessCleanup,
    );
    if (consumedWebRecovery && (!verifiedWebCleanup || consumedWebRecovery.replacement)) {
      const reason = consumedWebRecovery.replacement
        ? 'the single compiler-only replacement was already consumed'
        : checkCustody !== 'terminal'
          ? 'physical custody of the same-attempt checks is unknown'
          : 'terminal custody is known, but verified resultless cleanup for this exact run is unavailable';
      return {
        ...ref,
        status: 'pending' as const,
        result:
          `Web compiler recovery remains pending for check ${consumedWebRecovery.checkId}, physical run ${consumedWebRecovery.physicalRunId}: ${reason}. ` +
          'No compiler command was issued. Preserve the completed source until the existing check owner supplies its terminal receipt and prepared inputs, or resolves this exact run under the existing cleanup proof.',
      };
    }
    if (consumedWebRecovery && !authority)
      return {
        ...ref,
        status: 'pending' as const,
        result:
          `Verified resultless cleanup is terminal for Web check ${consumedWebRecovery.checkId}, physical run ${consumedWebRecovery.physicalRunId}. ` +
          'An authenticated owning or operations manager must run typing-recover to authorize its single compiler-only replacement; no source retry or compiler run was started.',
      };
    const resultlessCleanupRecovery = Boolean(
      verifiedWebCleanup ||
      (retainedKernelRun &&
        pendingCommand &&
        workerCheckHostAttemptHasResultlessCleanup(task.worktree, task.id, ref.attempt, checkIds, pendingCommand)),
    );
    if (resultlessCleanupRecovery && !authority)
      return {
        ...ref,
        status: 'pending' as const,
        result:
          'Verified resultless SIGTERM cleanup is settled. An authenticated owning or operations manager must run typing-recover before one compiler-only replacement can be authorized; no source retry or compiler run was started.',
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
      store.beginWithdrawnTypingRecoverySettlement(
        ref,
        attempt.result,
        webCompiler,
        {
          actor: authority,
          previousResult: attempt.result,
          recoveryKind: 'withdrawn-budget-stop',
          compilerCommand: webCompiler,
        },
        withdrawnOriginReport,
      );
      await settle(
        tasks,
        { attempt, exited: Promise.resolve({ code: attempt.exitCode ?? 0, signal: null }) },
        landing,
        afterSettle,
        { withdrawnBudgetRecovery: { previousResult: withdrawnOriginReport ?? attempt.result, command: webCompiler } },
      );
      return {
        ...ref,
        status: store.task(task.id).state === 'landing' ? ('landing' as const) : ('pending' as const),
      };
    }
    if (!typing.ok || (withdrawnRetry && !hasWebReceipt)) {
      const basePendingResult = typing.ok
        ? 'Compiler evidence for the retained Web source is missing; only the installed Web typecheck is authorized.'
        : typing.result;
      const original = (!typing.ok ? typing.command : undefined) ?? attempt.typingEvidencePending?.command ?? [];
      const expanded = expandCheckCommands(original);
      const resolvedWebCompiler = resolveTypingCompilerCommand(task.worktree, webCompiler);
      if (withdrawnRetry && !resolvedWebCompiler)
        throw new Error('Withdrawn retry recovery requires the installed owning Web typecheck');
      const directKernelEmitter = isKernelClientEmitterIntent(original);
      const exactKernelPipeline = isKernelClientTypingPipelineIntent(original);
      const kernelOutputIntent =
        hasKernelClientOutputIntent(original) ||
        exactKernelPipeline ||
        expanded.some((command) => hasKernelClientOutputIntent(command));
      let commands: string[][];
      if (withdrawnRetry) commands = [resolvedWebCompiler!];
      else if (directKernelEmitter || exactKernelPipeline) {
        const resolved = resolveTypingCompilerCommand(task.worktree, original);
        commands = resolved ? [resolved] : [];
      } else if (kernelOutputIntent) commands = [];
      else {
        commands = expanded
          .map((command) => resolveTypingCompilerCommand(task.worktree, command) ?? command)
          .filter((command) => !hasKernelClientOutputIntent(command))
          .filter(
            (command) => isTypecheckCommand(command) && (!authority || isKnownTypingCompiler(task.worktree, command)),
          );
      }
      const workspaceScoped = expanded.some(
        (command) =>
          (command[0] === 'bun' || command[0]?.endsWith('/bun')) &&
          command.length === 5 &&
          command[4] === 'typecheck' &&
          ((command[1] === 'run' && command[2] === '--cwd') || (command[1] === '--cwd' && command[3] === 'run')),
      );
      if (!commands.length && !workspaceScoped && !kernelOutputIntent) commands.push(['bun', 'scripts/typecheck.ts']);
      const supportedKernelPipeline =
        "sh -c 'bun run --cwd services/kernel typecheck --emit-client && bun run --cwd packages/client typecheck'";
      const pendingResult =
        kernelOutputIntent && !commands.length
          ? [
              basePendingResult,
              'The named Kernel client output has no validated recovery command in this compiler graph.',
              'Keep the same source and attempt. On a containing source that validates the installed owners, run only',
              `${supportedKernelPipeline} through the current worker-check wrapper, then repeat authenticated`,
              'typing-recover after its physical result is terminal. No root compiler fallback was issued.',
            ].join('\n')
          : basePendingResult;
      const grants = authority
        ? commands.map((command) =>
            grantWorkerTypingRecovery(
              {
                stateDirectory: settings.stateDirectory,
                database: store.db.filename,
                taskId: task.id,
                attempt: ref.attempt,
                worktree: task.worktree,
                command,
                actor: authority!,
                ...(withdrawnRetry ? { recoveryKind: 'withdrawn-budget-stop' as const } : {}),
              },
              { requireResultlessCleanupReplacement: resultlessCleanupRecovery },
            ),
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
