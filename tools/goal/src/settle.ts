import {
  workerBootCustody,
  HOST_INTERRUPTION_EVENT,
  HOST_INTERRUPTION_RETAINED,
  primaryWorkerStderr,
} from './worker-host-custody.ts';
import { readProofObservation, proofSourceStatus, nativeCheckId, registeredProof } from './verification.ts';
import { createHash } from 'node:crypto';
import { parseAgentExit } from './agents.ts';
import type { LandingQueue } from './contracts.ts';
import { readFileSync } from 'node:fs';
import { makeRecord, readLogTail, readMeasurement, reportedApproaches, reportsSuccess } from './records.ts';
import { agentAdapter } from './agents.ts';
import {
  isTransportFailure,
  isCursorResumeStopped,
  lastNonemptyLine,
  CURSOR_FRESH_SESSION_EVENT,
  CURSOR_FRESH_SESSION_RETRY_LIMIT,
  TRANSPORT_FAILURE_EVENT,
  TRANSPORT_RETRY_LIMIT,
  transportFailureLine,
  transportRetryBackoffMs,
} from './agents/shared.ts';
import { evidenceBundle } from './evidence.ts';
import { isEmptyProcessGroupUnconfirmed, terminateProcessGroup, processIdentity } from './process.ts';
import { releaseWorkerTemporaryDirectory, type RunningWorker } from './launch.ts';
import { removeAttemptContainers } from './worker-containers.ts';
import { reapAttemptResources } from './attempt-resources.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import type { WorkerTasks } from './tasks.ts';
import { git } from './tasks.ts';
import { completeWorkerSourceBaseline } from './conflict-progress.ts';
import { harvestContinuations } from './continuation.ts';
import type { Task } from './types.ts';
import { defaultPolicy } from './policy.ts';
import {
  workerCheckBudgetDirectory,
  workerCheckHostBudgetLimit,
  workerCheckHostBudgetRefusalReport,
  workerCheckHostTypingReceiptMatches,
  workerCheckHostTypingSettlement,
  workerCheckHostWithdrawnRetryIsRecoverable,
} from './worker-check-budget.ts';

function readAttemptStderr(logPath: string): string {
  try {
    return readFileSync(`${logPath}.err`, 'utf8');
  } catch {
    return '';
  }
}

function unchangedSource(task: Task, head: string): boolean {
  const frozen = new Set((task as Task & { frozenFiles?: { path: string }[] }).frozenFiles?.map((file) => file.path));
  return !git(task.worktree, ['diff', '--name-only', '-z', task.base, head])
    .split('\0')
    .some((path) => path && !frozen.has(path));
}

function proofObservationCheckId(
  observation: Awaited<ReturnType<typeof readProofObservation>> | undefined,
): string | undefined {
  if (
    !observation ||
    !observation.record ||
    typeof observation.record !== 'object' ||
    Array.isArray(observation.record)
  )
    return undefined;
  const id = (observation.record as { id?: unknown }).id;
  return typeof id === 'string' && nativeCheckId.test(id) ? id : undefined;
}

const SQLITE_CONTENTION = /SQLITE_(?:BUSY|LOCKED)|database (?:table )?is locked/i;
/** Another process held the store's write lock longer than the busy timeout. */
export function isSqliteContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    (typeof code === 'string' && SQLITE_CONTENTION.test(code)) ||
    (error instanceof Error && SQLITE_CONTENTION.test(error.message))
  );
}
/** Retry one persistence action with the same bounded schedule used by ordinary worker settlement. */
export async function retrySettlementPersistence<T>(action: () => T, backoffMs: readonly number[]): Promise<T> {
  for (let index = 0; ; index++) {
    try {
      return action();
    } catch (error) {
      if (!isSqliteContention(error) || index >= backoffMs.length) throw error;
      await Bun.sleep(backoffMs[index]!);
    }
  }
}
/** The one same-session request for the exit object of a worker that exited 0 without it. */
export const FINAL_REPORT_REQUESTED = 'final-report-requested';
export const FINAL_REPORT_PROMPT =
  'Your last run ended without the required JSON exit object. Do not edit, commit, run commands or checks, or repeat any work. Reply with only the exit object (status, summary, blocker, checks, approaches) for the work this session has already done: success with an empty checks array when your outcome is complete, otherwise blocked with the real blocker.';
/** Whether the attempt waits for its report-only continuation: requested, and no run started since. */
export function finalReportPending(store: WorkerTasks['store'], ref: { taskId: string; attempt: number }): boolean {
  return (
    store
      .events(ref.taskId, ref.attempt)
      .findLast((event) => event.kind === FINAL_REPORT_REQUESTED || event.kind === 'worker-run-started')?.kind ===
    FINAL_REPORT_REQUESTED
  );
}
/** Pauses between settlement write tries; each try already waits the store's busy timeout. */
export const SETTLEMENT_CONTENTION_BACKOFF_MS = defaultPolicy.worker.settlementBackoffMs;

/**
 * Await the worker's exit notification. No model, interval, or sleep loop participates in settlement. Git and other
 * child processes run outside the store's write transactions, so settlement never holds the lock while they run, and
 * a write that meets another process's lock is retried: contention is not a worker failure.
 */
export async function settle(
  tasks: WorkerTasks,
  worker: Pick<RunningWorker, 'attempt' | 'exited' | 'logStartOffset' | 'resuming'>,
  landing: LandingQueue,
  startTrain: () => Promise<void> = async () => {},
  recovery?: { withdrawnBudgetRecovery: { previousResult: string; command: string[] } },
): Promise<void> {
  const ref = worker.attempt;
  const policy = tasks.settings.policy ?? defaultPolicy;
  let code: number | null;
  let exitSignal: string | null = null;
  try {
    const exit = await worker.exited;
    code = exit.code;
    exitSignal = exit.signal;
  } catch {
    code = -1;
  }
  const store = tasks.store;
  const write = (action: () => void): Promise<void> =>
    retrySettlementPersistence(() => store.write(ref, action), policy.worker.settlementBackoffMs);
  const runEvent = store
    .events(ref.taskId, ref.attempt)
    .filter((event) => event.kind === 'worker-run-started')
    .at(-1);
  let runMetadata: { logStartOffset?: number; resuming?: boolean; workerHost?: unknown } = {};
  try {
    runMetadata = runEvent ? (JSON.parse(runEvent.body) as typeof runMetadata) : {};
  } catch {
    /* A malformed historical run marker does not prevent ordinary settlement. */
  }
  const logStartOffset = worker.logStartOffset ?? runMetadata.logStartOffset;
  const resuming = worker.resuming ?? runMetadata.resuming === true;
  let lease;
  try {
    lease = acquireDirectoryLease(`${store.attempt(ref).logPath}.settle`, policy.leases);
  } catch (error) {
    if (error instanceof LeaseHeldError) return; // A live settler will record checks and request landing.
    throw error;
  }
  try {
    // This is the common completion path for normal exits, stops, timeouts and orphan recovery.
    // Stopped or superseded attempts still need Docker cleanup even though they no longer settle records.
    const currentAttempt = store.attempt(ref);
    const poolForAttempt = tasks.settings.pools.find((p) => p.name === ref.pool);
    const initialMeasurement = readMeasurement(currentAttempt, {
      policy,
      configDirectory: poolForAttempt?.configDirectory,
      maxLogBytes: policy.worker.logTailBytes,
      ...(logStartOffset !== undefined ? { logStartOffset } : {}),
    });
    const pendingChecks = initialMeasurement.waitingChecks;
    const proofTaskRecord = store.task(ref.taskId);
    const proofTask = proofTaskRecord.brief.kind === 'verification';
    const proofObservation = proofTask
      ? await readProofObservation(
          store.task(ref.taskId),
          pendingChecks?.length ? pendingChecks : currentAttempt.checks,
        )
      : undefined;
    const proofCheckId = proofObservationCheckId(proofObservation);
    const ownedOrdinaryProofPass = Boolean(
      proofTask &&
      !proofTaskRecord.proofRun &&
      registeredProof(proofTaskRecord.brief, proofTaskRecord.proofAuthorization) &&
      proofObservation?.status === 'terminal' &&
      proofObservation.passed,
    );
    const currentBoot = processIdentity()?.boot ?? null;
    const bootCustody = currentAttempt.process
      ? workerBootCustody(currentAttempt.process, runMetadata.workerHost, currentBoot)
      : 'current-boot';
    if (
      code === null &&
      exitSignal === null &&
      bootCustody !== 'current-boot' &&
      !proofTask &&
      ['running', 'pending'].includes(currentAttempt.state) &&
      (bootCustody !== 'previous-local-boot' ||
        (!reportsSuccess(initialMeasurement.result, agentAdapter(currentAttempt.profile.cli)) &&
          !initialMeasurement.failureKind &&
          !initialMeasurement.blocker))
    ) {
      const adapter = agentAdapter(currentAttempt.profile.cli);
      const session = initialMeasurement.session ?? currentAttempt.session;
      const interruptions = store
        .events(ref.taskId, ref.attempt)
        .filter((event) => event.kind === HOST_INTERRUPTION_EVENT || event.kind === TRANSPORT_FAILURE_EVENT).length;
      const canResume =
        bootCustody === 'previous-local-boot' &&
        adapter.canResume &&
        Boolean(session) &&
        interruptions < (policy.worker.transportRetryLimit ?? TRANSPORT_RETRY_LIMIT);
      const line = canResume
        ? 'Confirmed local host reboot interrupted this worker; CLI exit status is unobserved.'
        : `${HOST_INTERRUPTION_RETAINED} ${bootCustody === 'unknown-host' ? 'host provenance is unavailable or foreign' : 'no resumable session or same-attempt interruption budget exhausted'}; CLI exit status is unobserved.`;
      await write(() => {
        store.assertCurrent(ref);
        const task = store.task(ref.taskId);
        const latest = store.attempt(ref);
        const latestRun = store
          .events(ref.taskId, ref.attempt)
          .findLast((event) => event.kind === 'worker-run-started');
        if (
          !['running', 'ready'].includes(task.state) ||
          !['running', 'pending'].includes(latest.state) ||
          latest.terminationIntent ||
          (latestRun?.sequence ?? 0) !== (runEvent?.sequence ?? 0) ||
          JSON.stringify(latest.process) !== JSON.stringify(currentAttempt.process)
        )
          return;
        store.updateAttempt(ref, (attempt) => {
          attempt.state = canResume ? 'waiting' : 'exited';
          attempt.driver = null;
          if (bootCustody === 'previous-local-boot') attempt.process = null;
          attempt.session = session;
          attempt.exitCode = null;
          attempt.result = line;
          attempt.failureKind = canResume ? null : 'tool';
          if (!canResume) attempt.endedAt = new Date().toISOString();
          if (pendingChecks?.length) attempt.checks = [...new Set([...(attempt.checks ?? []), ...pendingChecks])];
        });
        store.updateTask(ref, (task) => {
          task.state = canResume ? 'running' : 'stopped';
        });
        const delayMs = transportRetryBackoffMs(interruptions + 1, policy.worker.transportRetryBackoffMs);
        store.event(ref, HOST_INTERRUPTION_EVENT, {
          previousReport: initialMeasurement.result,
          previousProcess: currentAttempt.process,
          resume: canResume,
          count: interruptions + 1,
          custody: bootCustody,
          previousBoot: currentAttempt.process?.boot,
          currentBoot,
          line,
          nextResumeAt: new Date(
            Date.now() + (process.env.REZICS_GOAL_TEST_ENVIRONMENT === '1' ? 0 : delayMs),
          ).toISOString(),
          delayMs,
        });
      });
      return;
    }
    if (!proofTask && !pendingChecks?.length) {
      removeAttemptContainers(ref.taskId, ref.attempt, policy.containers);
      await reapAttemptResources({
        taskId: ref.taskId,
        stateDirectory: tasks.settings.stateDirectory,
        reapProcesses: false,
        containers: policy.containers,
      });
    }
    store.assertCurrent(ref);
    try {
      if (bootCustody !== 'previous-local-boot')
        await terminateProcessGroup(
          store.attempt(ref).process,
          tasks.settings.terminationGraceMs,
          tasks.settings.policy?.process,
        );
    } catch (error) {
      // The wrapper already exited; a zombie linger must not hide the worker's real stderr as unconfirmed custody.
      const identity = store.attempt(ref).process;
      if (!identity || !isEmptyProcessGroupUnconfirmed(error, identity.group)) throw error;
    }
    if (!proofTask && !pendingChecks?.length) {
      if (!store.task(ref.taskId).workspace)
        await reapAttemptResources({
          taskId: ref.taskId,
          stateDirectory: tasks.settings.stateDirectory,
          worktree: store.task(ref.taskId).worktree,
          reapDocker: false,
          graceMs: tasks.settings.terminationGraceMs,
          containers: policy.containers,
        });
    }
    // A check still pending may be running in this directory, so it outlives this settlement.
    if (!pendingChecks?.length && !(proofObservation?.status === 'running' && proofCheckId))
      releaseWorkerTemporaryDirectory(ref.taskId);
    let queued = false;
    let finished = false;
    let exited = false;
    let bundle = false;
    let typingEvidencePending: { result: string; command?: string[] } | undefined;
    // Whether the branch has commits matters only for a nonzero exit without a session.
    let committed = false;
    if (code !== null && code !== 0)
      try {
        const task = store.task(ref.taskId);
        committed = /^[1-9]\d*$/.test(git(task.worktree, ['rev-list', '--count', `${task.base}..HEAD`]).trim());
      } catch {
        /* An unreadable branch counts as having no commits. */
      }
    await write(() => {
      if (
        store.events(ref.taskId).some((event) => event.attempt === ref.attempt && event.kind === 'landing-requested')
      ) {
        queued = true;
        return;
      }
      const task = store.task(ref.taskId);
      const pool = tasks.settings.pools.find((p) => p.name === ref.pool);
      const current = store.attempt(ref);
      const endedAt = new Date().toISOString();
      const measurement = readMeasurement(
        { ...current, endedAt },
        {
          policy,
          configDirectory: pool?.configDirectory,
          ...(logStartOffset !== undefined ? { logStartOffset } : {}),
        },
      );
      const rawStderr = readAttemptStderr(current.logPath);
      const stderr = primaryWorkerStderr(rawStderr);
      const adapter = agentAdapter(current.profile.cli);
      if (
        resuming &&
        !proofTask &&
        code !== 0 &&
        !measurement.session &&
        !measurement.failureKind &&
        !measurement.blocker &&
        !reportsSuccess(measurement.result, adapter) &&
        !isTransportFailure(stderr, code)
      ) {
        const detail = (
          lastNonemptyLine(stderr) ||
          stderr.trim() ||
          measurement.result ||
          `Worker CLI exited with code ${code ?? 'unknown'} before starting a session`
        )
          .replace(/[\r\n]+/g, ' ')
          .slice(0, policy.worker.diagnosticCharacters);
        const errorLine = detail.split(/\r?\n/, 1)[0]!.slice(0, policy.worker.summaryCharacters);
        const failures = store
          .events(ref.taskId, ref.attempt)
          .filter((event) => event.kind === 'waiting-resume-launch-failed').length;
        store.updateAttempt(ref, (attempt) => {
          attempt.state = 'waiting';
          attempt.process = null;
          attempt.driver = null;
          attempt.exitCode = code;
          attempt.result = detail;
          attempt.failureKind = null;
        });
        store.event(ref, 'waiting-resume-launch-failed', {
          count: failures + 1,
          detail,
          errorLine,
        });
        return;
      }
      const proofExit = proofTask ? parseAgentExit(measurement.result, adapter) : null;
      const waitingId =
        proofExit &&
        typeof proofExit === 'object' &&
        'checks' in proofExit &&
        Array.isArray(proofExit.checks) &&
        proofExit.checks.length === 1 &&
        typeof proofExit.checks[0] === 'string' &&
        nativeCheckId.test(proofExit.checks[0])
          ? proofExit.checks[0]
          : undefined;
      const lostReportWaitingId =
        proofTask && proofExit === null && proofObservation?.status === 'running' ? proofCheckId : undefined;
      const proofWaitingId = waitingId ?? lostReportWaitingId;
      if (
        (pendingChecks?.length || lostReportWaitingId) &&
        (!proofTask ||
          (proofWaitingId &&
            (!pendingChecks?.length || (pendingChecks.length === 1 && pendingChecks[0] === proofWaitingId)) &&
            (proofObservation?.status === 'running' || proofObservation?.status === 'terminal')))
      ) {
        store.updateAttempt(ref, (attempt) => {
          attempt.state = 'waiting';
          attempt.checks = pendingChecks?.length ? pendingChecks : [proofWaitingId!];
          attempt.process = null;
          attempt.driver = null;
          attempt.exitCode = code;
          attempt.session = measurement.session ?? attempt.session;
        });
        return;
      }
      // A worker that exited 0 without its exit object is asked for it once, in the same session and attempt, instead
      // of spending another attempt that repeats its checks. The host resumes it like a check wake.
      const session = measurement.session ?? current.session;
      if (
        code === 0 &&
        !proofTask &&
        session &&
        adapter.canResume &&
        !measurement.failureKind &&
        !measurement.blocker &&
        !reportsSuccess(measurement.result, adapter) &&
        !store.events(ref.taskId, ref.attempt).some((event) => event.kind === FINAL_REPORT_REQUESTED)
      ) {
        store.updateAttempt(ref, (attempt) => {
          attempt.state = 'waiting';
          attempt.checks = [];
          attempt.process = null;
          attempt.driver = null;
          attempt.exitCode = code;
          attempt.session = session;
          attempt.result = measurement.result;
        });
        store.event(ref, FINAL_REPORT_REQUESTED, {
          result: measurement.result.slice(-policy.worker.reportResultCharacters),
        });
        return;
      }
      const cursorResumeStops = store
        .events(ref.taskId, ref.attempt)
        .filter((event) => event.kind === CURSOR_FRESH_SESSION_EVENT).length;
      if (
        adapter.cli === 'cursor' &&
        isCursorResumeStopped(stderr) &&
        cursorResumeStops < CURSOR_FRESH_SESSION_RETRY_LIMIT &&
        !measurement.failureKind &&
        !measurement.blocker &&
        !reportsSuccess(measurement.result, adapter)
      ) {
        // Cursor cannot resume through Goal; one immediate fresh launch keeps this provider message out of outages.
        const line = lastNonemptyLine(stderr).slice(0, policy.worker.summaryCharacters);
        store.updateAttempt(ref, (attempt) => {
          attempt.state = 'waiting';
          attempt.process = null;
          attempt.driver = null;
          attempt.exitCode = code;
          attempt.session = null;
          attempt.result = line;
          attempt.failureKind = null;
          attempt.blocker = null;
        });
        store.event(ref, CURSOR_FRESH_SESSION_EVENT, { count: cursorResumeStops + 1, line });
        return;
      }
      const transport = isTransportFailure(stderr, code);
      const transportLine = transport
        ? (transportFailureLine(stderr) || lastNonemptyLine(stderr)).slice(0, policy.worker.summaryCharacters)
        : '';
      const transportFailures = store
        .events(ref.taskId, ref.attempt)
        .filter((event) => event.kind === TRANSPORT_FAILURE_EVENT || event.kind === HOST_INTERRUPTION_EVENT).length;
      if (
        transport &&
        !proofTask &&
        transportLine &&
        transportFailures < (policy.worker.transportRetryLimit ?? TRANSPORT_RETRY_LIMIT) &&
        !measurement.failureKind &&
        !measurement.blocker &&
        !reportsSuccess(measurement.result, adapter)
      ) {
        const count = transportFailures + 1;
        const delayMs = transportRetryBackoffMs(count, policy.worker.transportRetryBackoffMs);
        const waitMs = process.env.REZICS_GOAL_TEST_ENVIRONMENT === '1' ? 0 : delayMs;
        const nextResumeAt = new Date(Date.now() + waitMs).toISOString();
        store.updateAttempt(ref, (attempt) => {
          attempt.state = 'waiting';
          attempt.process = null;
          attempt.driver = null;
          attempt.exitCode = code;
          attempt.session = session;
          attempt.result = transportLine;
          attempt.failureKind = null;
        });
        store.event(ref, TRANSPORT_FAILURE_EVENT, {
          count,
          line: transportLine,
          delayMs,
          nextResumeAt,
        });
        return;
      }
      const attempt = store.updateAttempt(ref, (a) => {
        a.state = 'exited';
        a.endedAt = endedAt;
        a.exitCode = code;
        a.after = pool ? tasks.reader(pool) : null;
      });
      exited = true;
      const finalMeasurement = readMeasurement(attempt, {
        policy,
        configDirectory: pool?.configDirectory,
        maxLogBytes: policy.worker.logTailBytes,
        ...(logStartOffset !== undefined ? { logStartOffset } : {}),
      });
      if (recovery?.withdrawnBudgetRecovery) {
        const { previousResult, command } = recovery.withdrawnBudgetRecovery;
        const directory = workerCheckBudgetDirectory(tasks.settings.stateDirectory, ref.taskId, ref.attempt);
        const progressEvent = store
          .events(ref.taskId, ref.attempt)
          .findLast((event) => event.kind === 'attempt-progress');
        let progress: { endHead?: unknown; uncommitted?: unknown } | undefined;
        try {
          progress = progressEvent ? (JSON.parse(progressEvent.body) as typeof progress) : undefined;
        } catch {
          progress = undefined;
        }
        if (
          task.brief.goal !== 'web' ||
          task.brief.kind !== 'interface' ||
          (current.state !== 'stopped' &&
            !(
              current.state === 'exited' &&
              JSON.stringify(current.typingEvidencePending?.command) ===
                JSON.stringify(['bun', 'run', '--cwd', 'apps/web', 'typecheck'])
            )) ||
          current.result !== previousResult ||
          !workerCheckHostBudgetRefusalReport(current.result) ||
          JSON.stringify(command) !== JSON.stringify(['bun', 'run', '--cwd', 'apps/web', 'typecheck']) ||
          !workerCheckHostTypingReceiptMatches(directory, command) ||
          !workerCheckHostTypingSettlement({
            directory,
            worktree: task.worktree,
            limit: workerCheckHostBudgetLimit(task, ref.attempt),
          }).ok ||
          !workerCheckHostWithdrawnRetryIsRecoverable({
            task,
            attempt: current,
            retry: store.retryIntent(ref),
            ...(progress ? { progress } : {}),
          })
        )
          throw new Error('Withdrawn retry source no longer has exact terminal Web compiler evidence');
        finalMeasurement.result = JSON.stringify({
          status: 'success',
          summary:
            'Retained source passed the installed owning Web typecheck; remaining acceptance stays with integration.',
          blocker: null,
          checks: [],
          approaches: [],
        });
        finalMeasurement.blocker = null;
        finalMeasurement.failureKind = null;
        finalMeasurement.waitingChecks = null;
      }
      const noReportProofPass = ownedOrdinaryProofPass && parseAgentExit(finalMeasurement.result, adapter) === null;
      if (pool)
        try {
          agentAdapter(pool.cli).afterExit(pool, readLogTail(attempt.logPath, policy.worker.logTailBytes));
        } catch {
          /* No log to read. */
        }
      // A CLI can fail before opening a session, so there is no structured event in its JSONL log.
      // Preserve that launch failure on the attempt and keep it out of the landing queue.
      if (
        !noReportProofPass &&
        !finalMeasurement.session &&
        code !== null &&
        code !== 0 &&
        !finalMeasurement.failureKind &&
        !committed
      ) {
        // Cursor refuses a spent model this way; the pool must be excluded, not the launch retried and stalled.
        finalMeasurement.failureKind = adapter.signals?.(stderr).allowance ? 'pool-exhausted' : 'tool';
        finalMeasurement.result =
          lastNonemptyLine(stderr) || stderr.trim() || `Worker CLI exited with code ${code} before starting a session`;
      }
      // Only a worker's own final answer, a success report or a stated blocker, lets its branch land. A worker killed
      // mid-work gives none, and its partial worktree must not be committed and integrated as if it had passed.
      if (
        !finalMeasurement.failureKind &&
        !finalMeasurement.blocker &&
        !reportsSuccess(finalMeasurement.result, adapter) &&
        !noReportProofPass
      ) {
        const parsed = parseAgentExit(finalMeasurement.result, adapter);
        const errorLine = lastNonemptyLine(stderr);
        const detail =
          (!finalMeasurement.result.trim() || parsed == null) && errorLine
            ? errorLine
            : finalMeasurement.result.slice(-policy.worker.failedResultCharacters);
        // Cursor also refuses a spent allowance mid-session ("You're out of usage"); it excludes the pool, not a tool fault.
        finalMeasurement.failureKind = adapter.signals?.(stderr).allowance ? 'pool-exhausted' : 'tool';
        finalMeasurement.result = `Worker ended without a success report (${code === null ? (exitSignal ? `signal ${exitSignal}` : 'exit unobserved') : `exit ${code}`}): ${detail}`;
        if (transportLine) finalMeasurement.blocker = transportLine;
      }
      if (
        !finalMeasurement.failureKind &&
        !finalMeasurement.blocker &&
        reportsSuccess(finalMeasurement.result, agentAdapter(attempt.profile.cli))
      ) {
        const typing = workerCheckHostTypingSettlement({
          directory: workerCheckBudgetDirectory(tasks.settings.stateDirectory, ref.taskId, ref.attempt),
          worktree: task.worktree,
          limit: workerCheckHostBudgetLimit(task, ref.attempt),
        });
        if (!typing.ok) {
          if (typing.kind === 'evidence-unavailable') {
            typingEvidencePending = { result: typing.result, ...(typing.command ? { command: typing.command } : {}) };
          } else {
            finalMeasurement.failureKind = 'tool';
            finalMeasurement.result = typing.result;
          }
        }
      }
      store.updateAttempt(ref, (a) => {
        a.session = finalMeasurement.session ?? a.session;
        a.result = finalMeasurement.result;
        a.blocker = finalMeasurement.blocker;
        a.failureKind = finalMeasurement.failureKind;
        if (typingEvidencePending) a.typingEvidencePending = typingEvidencePending;
        else delete a.typingEvidencePending;
        a.approaches.push(
          ...reportedApproaches(finalMeasurement.result, agentAdapter(attempt.profile.cli), policy.records),
        );
      });
      store.putRecord(makeRecord(task, attempt, finalMeasurement));
      bundle = true;
      if (typingEvidencePending) {
        store.updateTask(ref, (current) => {
          current.state = 'stopped';
        });
        if (store.retryIntent(ref)?.status === 'pending')
          store.updateRetryIntent(ref, (intent) => {
            intent.status = 'abandoned';
          });
        store.event(ref, 'typing-evidence-pending', typingEvidencePending);
        return;
      }
      if (finalMeasurement.failureKind && !proofTask) return;
      if (proofTask && proofObservation) {
        const run = task.proofRun;
        const exit = parseAgentExit(finalMeasurement.result, agentAdapter(attempt.profile.cli));
        const structured = Boolean(
          exit &&
          typeof exit === 'object' &&
          'status' in exit &&
          exit.status === 'success' &&
          'checks' in exit &&
          Array.isArray(exit.checks) &&
          exit.checks.length === 0,
        );
        const sourceStatus = proofSourceStatus(task, tasks.settings.integrationBranch, tasks.settings.policy?.proof);
        const unchanged = sourceStatus === 'current';
        const sourceDiagnostic =
          sourceStatus === 'capture-changed'
            ? '; captured source changed'
            : sourceStatus === 'integration-not-current'
              ? '; capture is not current integration'
              : '';
        const ordinaryNoReportPass =
          noReportProofPass && proofObservation.status === 'terminal' && proofObservation.passed;
        const observedPass =
          !finalMeasurement.failureKind &&
          !finalMeasurement.blocker &&
          proofObservation.status === 'terminal' &&
          proofObservation.passed &&
          (ordinaryNoReportPass || (code === 0 && structured));
        const verified = observedPass && unchanged;
        const captureOnly = observedPass && sourceStatus === 'integration-not-current';
        const proofRecord = makeRecord(task, attempt, finalMeasurement, verified ? 'verified' : 'stopped');
        proofRecord.proof = proofObservation;
        store.putRecord(proofRecord);
        store.updateTask(ref, (current) => {
          current.state = verified ? 'verified' : 'stopped';
        });
        store.updateAttempt(ref, (current) => {
          current.failureKind = verified || captureOnly ? null : 'tool';
          current.result = `${finalMeasurement.result}\n${proofObservation.cause}${sourceDiagnostic}`;
        });
        store.releaseExitedProofReservations(ref);
        store.event(ref, verified ? 'proof-verified' : captureOnly ? 'proof-capture-not-current' : 'proof-failed', {
          binding: run?.binding,
          observation: proofObservation,
          sourceStatus,
          unchanged,
          structured,
          ordinaryNoReportPass,
        });
        return;
      }
      finished = true;
    });
    if (bundle) evidenceBundle(store.task(ref.taskId), store.attempt(ref), undefined, store.policy.evidence);
    if (finished) {
      store.assertCurrent(ref);
      const task = store.task(ref.taskId);
      const branchHead = git(task.worktree, ['rev-parse', `${task.branch}^{commit}`]);
      const dirtyUnchangedSource =
        unchangedSource(task, branchHead) &&
        git(task.worktree, ['status', '--porcelain', '--untracked-files=all']) !== '';
      if (!dirtyUnchangedSource) tasks.commitFinishedWork(task, ref.attempt);
    }
    // Continuation briefs move to the Goal backlog when the attempt ends, whatever its result.
    if (exited)
      try {
        harvestContinuations(store, tasks.settings, store.task(ref.taskId), ref);
      } catch (error) {
        console.error(`Continuation briefs of task ${ref.taskId} attempt ${ref.attempt} were not moved:`, error);
      }
    if (finished) {
      const task = store.task(ref.taskId);
      const branchHead = git(task.worktree, ['rev-parse', `${task.branch}^{commit}`]);
      const sourceBaselineEvent = store
        .events(ref.taskId, ref.attempt)
        .findLast((event) => event.kind === 'worker-source-baseline');
      let workerCommit = branchHead;
      if (sourceBaselineEvent) {
        try {
          const baseline = completeWorkerSourceBaseline(JSON.parse(sourceBaselineEvent.body));
          if (baseline && branchHead === baseline.controllerHead) workerCommit = baseline.workerCommit;
        } catch {
          /* A malformed or legacy source baseline cannot establish historical worker progress. */
        }
      }
      const unchangedClaim = !task.workspace && unchangedSource(task, workerCommit) && branchHead === workerCommit;
      const sourceDirtyAtSettlement =
        unchangedClaim && git(task.worktree, ['status', '--porcelain', '--untracked-files=all']) !== '';
      evidenceBundle(task, store.attempt(ref), undefined, store.policy.evidence);
      await write(() => {
        // Contract amendment and landing publication share this fence: never enqueue an earlier scope or gate.
        const contract = store.task(ref.taskId);
        store.updateTask(ref, (t) => {
          t.state = 'landing';
        });
        store.landing(
          {
            taskId: task.id,
            attempt: ref.attempt,
            branch: task.branch,
            worktree: task.worktree,
            workerCommit,
            ...(unchangedClaim
              ? {
                  unchangedClaim: true as const,
                  contractHash: createHash('sha256').update(contract.brief.markdown).digest('hex'),
                  ...(sourceDirtyAtSettlement ? { sourceDirtyAtSettlement: true as const } : {}),
                }
              : {}),
            declaredPaths: contract.brief.paths,
            protectedRiskAreas: tasks.protectedRiskAreas(contract.brief),
            gate: contract.brief.acceptance.command,
          },
          (request) => landing.enqueue(request),
        );
      });
      queued = true;
    }
    // Start only after the enqueue transaction commits; a busy train is awaited through its lease.
    if (queued) await startTrain();
  } finally {
    lease.release();
  }
}
