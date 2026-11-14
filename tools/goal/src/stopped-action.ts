import type { Database } from 'bun:sqlite';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acceptedSuccessorDisposition, preservesTerminalProof } from './owner-decisions.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import type { WorkerEvent } from './store.ts';
import type { Task } from './types.ts';
import { nativeCheckId, observeOrdinaryProof, ownedCurrentOrdinaryProofInvocation } from './verification.ts';
import {
  workerCheckBudgetDirectory,
  workerCheckHostActiveTypingRecovery,
  workerCheckHostConsumedTypingRecovery,
} from './worker-check-budget.ts';

export type StoppedActionHint = 'actionable' | 'preserved' | 'inspect-proof' | 'typing-recovery';

export type StoppedActionProjection =
  | { kind: 'preserved'; actionable: false }
  | { kind: 'repair'; actionable: true }
  | {
      kind: 'evidence-receiver';
      actionable: boolean;
      owner: string | null;
      missingPredicate: string;
    };

/** Compact indexed facts for a stopped row. Only owner dispositions need structured event inspection. */
export function stoppedActionHint(
  taskId: 'c.task_id' | 't.id',
  attempt: 'c.current_attempt' | 't.current_attempt',
  hasWorkerEvents = true,
): string {
  // Without the event source, do not infer that a verification stop has preserved proof.
  const verificationDecision = hasWorkerEvents
    ? `WHEN EXISTS (
      SELECT 1 FROM worker_records r WHERE r.task_id=s.id AND r.attempt=s.current_attempt
        AND json_extract(r.body, '$.proof.status')='terminal'
    ) AND EXISTS (
      SELECT 1 FROM worker_events e WHERE e.task_id=s.id AND e.attempt=s.current_attempt AND e.kind='proof-failure-routed'
        AND json_extract(e.body, '$.managerId')=json_extract(s.body, '$.brief.manager')
    ) THEN 'preserved'
    WHEN EXISTS (
      SELECT 1 FROM worker_events e WHERE e.task_id=s.id AND e.attempt=s.current_attempt
        AND e.kind='owner-contract-decision-accepted'
    ) THEN 'inspect-proof'`
    : `WHEN coalesce(json_extract(s.body, '$.brief.kind'), '')='verification' THEN 'actionable'`;
  const acceptedSuccessor = hasWorkerEvents
    ? `WHEN coalesce(json_extract(s.body, '$.brief.kind'), '')!='verification' AND EXISTS (
      SELECT 1 FROM worker_events e WHERE e.task_id=s.id AND e.attempt<=s.current_attempt
        AND e.kind='owner-contract-decision-accepted'
    ) THEN 'inspect-proof'`
    : '';
  const typingRecovery = `
      coalesce(json_extract(a.body, '$.state'), '')='exited'
      AND json_extract(a.body, '$.exitCode')=0
      AND coalesce(json_extract(a.body, '$.failureKind'), '')=''
      AND coalesce(json_extract(a.body, '$.blocker'), '')=''
      AND json_extract(a.body, '$.terminationIntent') IS NULL
      AND (
        json_type(a.body, '$.typingEvidencePending')='object'
        OR coalesce(json_extract(a.body, '$.result'), '') LIKE 'Compiler input closure is unavailable for the last check-host typecheck.%'
        OR coalesce(json_extract(a.body, '$.result'), '') LIKE 'Worktree content changed after the last check-host typecheck.%'
      )`;
  return `(SELECT CASE
    WHEN json_extract(a.body, '$.terminationIntent.operation')='stop'
      AND coalesce(json_extract(a.body, '$.terminationIntent.requestedAt'), '')!='' THEN 'preserved'
    WHEN json_extract(a.body, '$.terminationIntent.operation')='cancel' AND (
      coalesce(json_extract(a.body, '$.terminationIntent.state'), '')!='complete' OR
      coalesce(json_extract(a.body, '$.terminationIntent.settledAt'), '')=''
    ) THEN 'preserved'
    WHEN coalesce(json_extract(s.body, '$.brief.kind'), '')!='verification' AND (${typingRecovery}) THEN 'typing-recovery'
    ${acceptedSuccessor}
    WHEN coalesce(json_extract(s.body, '$.brief.kind'), '')!='verification' THEN 'actionable'
    ${verificationDecision}
    ELSE 'actionable' END
    FROM worker_tasks s LEFT JOIN worker_attempts a ON a.task_id=s.id AND a.attempt=s.current_attempt
    WHERE s.id=${taskId} AND s.current_attempt=${attempt})`;
}

function taskEvents(db: Database, taskId: string, attempt: number): WorkerEvent[] {
  return db
    .query<WorkerEvent, [string, number]>(
      `SELECT sequence,task_id,attempt,kind,at,body FROM worker_events WHERE task_id=? AND attempt<=?
       AND kind IN ('owner-contract-decision-accepted','owner-contract-decisions-superseded') ORDER BY sequence`,
    )
    .all(taskId, attempt);
}

function hasIntegratedSuccessor(
  db: Database,
  task: Task,
  events: readonly WorkerEvent[],
  attempt: number,
  policy: ControlPolicy,
): boolean {
  const accepted = acceptedSuccessorDisposition(events, task, { taskId: task.id, attempt }, policy);
  if (!accepted) return false;
  const row = db.query<{ body: string }, [string]>('SELECT body FROM worker_tasks WHERE id=?').get(accepted.taskId);
  if (!row) return false;
  const linked = JSON.parse(row.body) as Partial<Task>;
  const exactCommit =
    linked.integratedCommit === accepted.commit ||
    linked.mergedCommit === accepted.commit ||
    (Array.isArray(linked.integratedCommits) && linked.integratedCommits.includes(accepted.commit));
  return Boolean(
    linked.id === accepted.taskId &&
    linked.brief?.goal === task.brief.goal &&
    linked.brief?.manager === task.brief.manager &&
    linked.brief?.kind !== 'verification' &&
    exactCommit,
  );
}

function successfulSourceAttempt(attempt: {
  state?: unknown;
  exitCode?: unknown;
  failureKind?: unknown;
  blocker?: unknown;
  terminationIntent?: unknown;
}): boolean {
  return (
    attempt.state === 'exited' &&
    attempt.exitCode === 0 &&
    (attempt.failureKind === undefined || attempt.failureKind === null || attempt.failureKind === '') &&
    (attempt.blocker === undefined || attempt.blocker === null || attempt.blocker === '') &&
    (attempt.terminationIntent === undefined || attempt.terminationIntent === null)
  );
}

function liveOrdinaryProofStop(task: Task, attemptBody: { terminationIntent?: { operation?: unknown } }): boolean {
  if (
    task.brief.kind !== 'verification' ||
    task.state !== 'stopped' ||
    attemptBody.terminationIntent?.operation === 'stop' ||
    attemptBody.terminationIntent?.operation === 'cancel'
  )
    return false;
  try {
    const owned = ownedCurrentOrdinaryProofInvocation(task);
    return Boolean(owned && observeOrdinaryProof(task, owned.id, owned.record).status === 'running');
  } catch {
    return false;
  }
}

function currentTypingRecoveryNeed(
  db: Database,
  task: Task,
  attempt: number,
  attemptBody: {
    taskId?: unknown;
    attempt?: unknown;
    state?: unknown;
    exitCode?: unknown;
    failureKind?: unknown;
    blocker?: unknown;
    terminationIntent?: unknown;
    checks?: unknown;
    typingEvidencePending?: { command?: unknown };
  },
): { missingPredicate: string; actionable: boolean } | null {
  if (task.brief.kind === 'verification' || attemptBody.state !== 'exited' || !successfulSourceAttempt(attemptBody))
    return null;

  const pendingEvidence = attemptBody.typingEvidencePending;
  if (!pendingEvidence || typeof pendingEvidence !== 'object' || Array.isArray(pendingEvidence))
    return {
      missingPredicate: 'the structured current compiler command or check identity is unavailable',
      actionable: true,
    };
  const pendingCommand = pendingEvidence.command;
  if (!Array.isArray(pendingCommand) || pendingCommand.some((part) => typeof part !== 'string'))
    return {
      missingPredicate: 'the exact current compiler command or check identity is unknown',
      actionable: true,
    };
  if (!Array.isArray(attemptBody.checks) || attemptBody.checks.some((check) => typeof check !== 'string'))
    return {
      missingPredicate: 'the exact current check identity is unknown',
      actionable: true,
    };
  const authorization = db
    .query<{ kind: string; body: string }, [string, number]>(
      `SELECT kind,body FROM worker_events WHERE task_id=? AND attempt=?
       AND kind IN ('typing-recovery-authorized','typing-evidence-recovery','typing-evidence-failed')
       ORDER BY sequence DESC LIMIT 1`,
    )
    .get(task.id, attempt);
  if (authorization?.kind === 'typing-evidence-failed') return null;
  if (authorization?.kind === 'typing-evidence-recovery')
    return {
      missingPredicate: 'the recovered compiler evidence reconciled into the current attempt',
      actionable: true,
    };
  if (!authorization || authorization.kind !== 'typing-recovery-authorized')
    return {
      missingPredicate: 'authenticated owner authorization to receive compiler evidence',
      actionable: true,
    };
  type AuthorizationBody = {
    token?: unknown;
    checkId?: unknown;
    command?: unknown;
    identity?: unknown;
    actor?: { id?: unknown; sessionId?: unknown };
  };
  let body: AuthorizationBody;
  try {
    body = JSON.parse(authorization.body) as AuthorizationBody;
  } catch {
    return {
      missingPredicate: 'valid authenticated recovery authorization for the exact current check',
      actionable: true,
    };
  }
  if (
    typeof body.token !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(body.token) ||
    typeof body.checkId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(body.checkId) ||
    typeof body.identity !== 'string' ||
    !/^[0-9a-f]{64}$/.test(body.identity) ||
    !body.actor ||
    typeof body.actor.id !== 'string' ||
    !body.actor.id ||
    typeof body.actor.sessionId !== 'string' ||
    !body.actor.sessionId ||
    JSON.stringify(body.command) !== JSON.stringify(pendingCommand)
  )
    return {
      missingPredicate: 'a valid authenticated recovery authorization bound to this exact check',
      actionable: true,
    };
  const recovery = workerCheckHostConsumedTypingRecovery({
    db,
    directory: workerCheckBudgetDirectory(dirname(db.filename), task.id, attempt),
    worktree: task.worktree,
    taskId: task.id,
    attempt,
    checkIds: attemptBody.checks,
    command: pendingCommand as string[],
    token: body.token,
  });
  if (!recovery)
    return {
      missingPredicate: 'the exact compiler result and its terminal custody',
      actionable: true,
    };
  if (!recovery.exact)
    return {
      missingPredicate: 'the exact current compiler check identity and terminal custody',
      actionable: true,
    };
  if (recovery.replacement)
    return {
      missingPredicate: 'terminal result and custody for the already authorized compiler-only replacement',
      actionable: true,
    };
  if (recovery.resultlessCleanup)
    return {
      missingPredicate: 'authenticated owner authorization for one compiler-only replacement after verified cleanup',
      actionable: true,
    };
  if (recovery.resultState === 'running') {
    if (recovery.custody === 'terminal')
      return {
        missingPredicate: 'the exact compiler result after its recorded terminal custody',
        actionable: true,
      };
    const active = workerCheckHostActiveTypingRecovery({
      db,
      stateDirectory: dirname(db.filename),
      taskId: task.id,
      worktree: task.worktree,
      token: body.token,
    });
    if (active?.checkId === body.checkId && active.physicalRunId === recovery.physicalRunId)
      return {
        missingPredicate: 'the terminal result and custody of the active exact compiler check',
        actionable: false,
      };
  }
  if (recovery.custody !== 'terminal')
    return {
      missingPredicate:
        recovery.resultState === 'finished'
          ? 'verified terminal custody for the exact compiler check'
          : 'the exact compiler result and verified terminal custody',
      actionable: true,
    };
  if (recovery.resultState !== 'finished')
    return {
      missingPredicate: 'a valid terminal result for the exact compiler check',
      actionable: true,
    };

  const resultPath = join(task.worktree, '.temp/goal/checks/results', `${recovery.checkId}.json`);
  try {
    const stat = lstatSync(resultPath);
    if (stat.isFile() && stat.size <= 256 * 1024) {
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
        id?: unknown;
        cwd?: unknown;
        argv?: unknown;
        status?: unknown;
        exitCode?: unknown;
        physicalRunId?: unknown;
        ownership?: { taskId?: unknown; attempt?: unknown };
      };
      if (
        result.id === recovery.checkId &&
        result.cwd === task.worktree &&
        result.physicalRunId === recovery.physicalRunId &&
        result.ownership?.taskId === task.id &&
        result.ownership.attempt === attempt &&
        JSON.stringify(result.argv) === JSON.stringify(pendingCommand) &&
        result.status === 'finished' &&
        Number.isInteger(result.exitCode)
      )
        return {
          missingPredicate:
            (result.exitCode as number) !== 0
              ? 'authenticated failure classification of the exact terminal compiler result'
              : 'authenticated reconciliation of the exact terminal compiler result',
          actionable: true,
        };
    }
  } catch {
    // The exact result is still unverified; keep the receiving obligation explicit.
  }
  return {
    missingPredicate: 'a valid exact compiler result accepted with its terminal custody',
    actionable: true,
  };
}

function receiverOwner(task: Task): string | null {
  const manager = task.brief?.manager;
  return typeof manager === 'string' && manager.trim() ? manager : null;
}

export function stoppedActionProjection(
  db: Database,
  taskId: string,
  attempt: number,
  hint: StoppedActionHint | null,
  policy = defaultPolicy,
): StoppedActionProjection {
  let knownOwner: string | null = null;
  const unknownReceiver = (owner: string | null = null): StoppedActionProjection => ({
    kind: 'evidence-receiver',
    actionable: true,
    owner,
    missingPredicate: 'the current owner or exact compiler evidence predicate could not be verified',
  });
  if (hint === 'preserved') return { kind: 'preserved', actionable: false };
  try {
    const liveRow = db
      .query<{ task: string; attemptBody: string }, [string, number]>(
        `SELECT t.body AS task, a.body AS attemptBody
         FROM worker_tasks t JOIN worker_attempts a ON a.task_id=t.id AND a.attempt=t.current_attempt
         WHERE t.id=? AND t.current_attempt=?`,
      )
      .get(taskId, attempt);
    if (liveRow && liveOrdinaryProofStop(JSON.parse(liveRow.task) as Task, JSON.parse(liveRow.attemptBody)))
      return { kind: 'preserved', actionable: false };
  } catch {
    /* Observation defects do not invent an actionable product stop. */
  }
  if (hint !== 'inspect-proof' && hint !== 'typing-recovery') return { kind: 'repair', actionable: true };
  try {
    const row = db
      .query<{ task: string; attemptBody: string; checks: string | null }, [string, number]>(
        `SELECT t.body AS task, a.body AS attemptBody, json_extract(a.body, '$.checks') AS checks
       FROM worker_tasks t JOIN worker_attempts a ON a.task_id=t.id AND a.attempt=t.current_attempt
       WHERE t.id=? AND t.current_attempt=?`,
      )
      .get(taskId, attempt);
    if (!row) return hint === 'typing-recovery' ? unknownReceiver() : { kind: 'repair', actionable: true };
    const task = JSON.parse(row.task) as Task;
    knownOwner = receiverOwner(task);
    const currentAttempt = JSON.parse(row.attemptBody) as {
      taskId?: unknown;
      attempt?: unknown;
      state?: unknown;
      exitCode?: unknown;
      failureKind?: unknown;
      blocker?: unknown;
      terminationIntent?: unknown;
      checks?: unknown;
      typingEvidencePending?: { command?: unknown };
    };
    if (
      task.id !== taskId ||
      task.currentAttempt !== attempt ||
      task.state !== 'stopped' ||
      currentAttempt.taskId !== taskId ||
      currentAttempt.attempt !== attempt
    )
      return hint === 'typing-recovery' ? unknownReceiver(knownOwner) : { kind: 'repair', actionable: true };

    const events = taskEvents(db, taskId, attempt);
    if (successfulSourceAttempt(currentAttempt) && hasIntegratedSuccessor(db, task, events, attempt, policy))
      return { kind: 'preserved', actionable: false };
    if (hint === 'typing-recovery') {
      const receiver = currentTypingRecoveryNeed(db, task, attempt, currentAttempt);
      if (!receiver) return { kind: 'repair', actionable: true };
      return {
        kind: 'evidence-receiver',
        actionable: receiver.actionable,
        owner: receiverOwner(task),
        missingPredicate: receiver.missingPredicate,
      };
    }
    if (task.brief.kind !== 'verification' || !row.checks) return { kind: 'repair', actionable: true };
    if (!preservesTerminalProof(events, task, { taskId, attempt }, policy)) return { kind: 'repair', actionable: true };
    const checks: unknown = JSON.parse(row.checks);
    if (
      !Array.isArray(checks) ||
      checks.length !== 1 ||
      typeof checks[0] !== 'string' ||
      !nativeCheckId.test(checks[0])
    )
      return { kind: 'repair', actionable: true };
    const owned = ownedCurrentOrdinaryProofInvocation(task);
    if (!owned) return { kind: 'repair', actionable: true };
    const path = join(task.worktree, '.temp/goal/checks/results', `${owned.id}.json`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > policy.proof.sourceBufferBytes) return { kind: 'repair', actionable: true };
    return observeOrdinaryProof(task, owned.id, JSON.parse(readFileSync(path, 'utf8'))).status !== 'terminal'
      ? { kind: 'repair', actionable: true }
      : { kind: 'preserved', actionable: false };
  } catch {
    // No unverifiable owner decision, compiler handoff or result silently suppresses an ordinary action.
    return hint === 'typing-recovery' ? unknownReceiver(knownOwner) : { kind: 'repair', actionable: true };
  }
}
