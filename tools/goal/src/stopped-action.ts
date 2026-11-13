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

function hasUnresolvedConsumedRecovery(
  db: Database,
  task: Task,
  attempt: number,
  attemptBody: {
    taskId?: unknown;
    attempt?: unknown;
    state?: unknown;
    checks?: unknown;
    typingEvidencePending?: { command?: unknown };
  },
): boolean {
  if (
    task.brief.kind === 'verification' ||
    attemptBody.state !== 'exited' ||
    !attemptBody.typingEvidencePending ||
    !Array.isArray(attemptBody.typingEvidencePending.command) ||
    attemptBody.typingEvidencePending.command.some((part) => typeof part !== 'string') ||
    !Array.isArray(attemptBody.checks) ||
    attemptBody.checks.some((check) => typeof check !== 'string')
  )
    return false;
  const authorization = db
    .query<{ kind: string; body: string }, [string, number]>(
      `SELECT kind,body FROM worker_events WHERE task_id=? AND attempt=?
       AND kind IN ('typing-recovery-authorized','typing-evidence-recovery','typing-evidence-failed')
       ORDER BY sequence DESC LIMIT 1`,
    )
    .get(task.id, attempt);
  if (!authorization || authorization.kind !== 'typing-recovery-authorized') return false;
  const body = JSON.parse(authorization.body) as {
    token?: unknown;
    checkId?: unknown;
    command?: unknown;
    identity?: unknown;
    actor?: { id?: unknown; sessionId?: unknown };
  };
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
    !attemptBody.checks.includes(body.checkId) ||
    JSON.stringify(body.command) !== JSON.stringify(attemptBody.typingEvidencePending.command)
  )
    return false;
  const recovery = workerCheckHostConsumedTypingRecovery({
    db,
    directory: workerCheckBudgetDirectory(dirname(db.filename), task.id, attempt),
    worktree: task.worktree,
    taskId: task.id,
    attempt,
    checkIds: attemptBody.checks,
    command: attemptBody.typingEvidencePending.command as string[],
    token: body.token,
  });
  if (
    !recovery ||
    !recovery.exact ||
    recovery.custody !== 'unknown' ||
    recovery.resultlessCleanup ||
    recovery.replacement
  )
    return false;
  if (recovery.resultState === 'absent') return true;
  if (recovery.resultState !== 'running') return false;
  const active = workerCheckHostActiveTypingRecovery({
    db,
    stateDirectory: dirname(db.filename),
    taskId: task.id,
    worktree: task.worktree,
    token: body.token,
  });
  return active?.checkId === body.checkId && active.physicalRunId === recovery.physicalRunId;
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

export function isActionableStop(
  db: Database,
  taskId: string,
  attempt: number,
  hint: StoppedActionHint | null,
  policy = defaultPolicy,
): boolean {
  if (hint === 'preserved') return false;
  try {
    const liveRow = db
      .query<{ task: string; attemptBody: string }, [string, number]>(
        `SELECT t.body AS task, a.body AS attemptBody
         FROM worker_tasks t JOIN worker_attempts a ON a.task_id=t.id AND a.attempt=t.current_attempt
         WHERE t.id=? AND t.current_attempt=?`,
      )
      .get(taskId, attempt);
    if (liveRow && liveOrdinaryProofStop(JSON.parse(liveRow.task) as Task, JSON.parse(liveRow.attemptBody)))
      return false;
  } catch {
    /* Observation defects do not invent an actionable product stop. */
  }
  if (hint !== 'inspect-proof' && hint !== 'typing-recovery') return true;
  try {
    const row = db
      .query<{ task: string; attemptBody: string; checks: string | null }, [string, number]>(
        `SELECT t.body AS task, a.body AS attemptBody, json_extract(a.body, '$.checks') AS checks
       FROM worker_tasks t JOIN worker_attempts a ON a.task_id=t.id AND a.attempt=t.current_attempt
       WHERE t.id=? AND t.current_attempt=?`,
      )
      .get(taskId, attempt);
    if (!row) return true;
    const task = JSON.parse(row.task) as Task;
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
      return true;

    const events = taskEvents(db, taskId, attempt);
    if (successfulSourceAttempt(currentAttempt) && hasIntegratedSuccessor(db, task, events, attempt, policy))
      return false;
    if (hint === 'typing-recovery') return !hasUnresolvedConsumedRecovery(db, task, attempt, currentAttempt);
    if (task.brief.kind !== 'verification' || !row.checks) return true;
    if (!preservesTerminalProof(events, task, { taskId, attempt }, policy)) return true;
    const checks: unknown = JSON.parse(row.checks);
    if (
      !Array.isArray(checks) ||
      checks.length !== 1 ||
      typeof checks[0] !== 'string' ||
      !nativeCheckId.test(checks[0])
    )
      return true;
    const owned = ownedCurrentOrdinaryProofInvocation(task);
    if (!owned) return true;
    const path = join(task.worktree, '.temp/goal/checks/results', `${owned.id}.json`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > policy.proof.sourceBufferBytes) return true;
    return observeOrdinaryProof(task, owned.id, JSON.parse(readFileSync(path, 'utf8'))).status !== 'terminal';
  } catch {
    // No unverifiable owner decision, compiler handoff or result silently suppresses an ordinary action.
    return true;
  }
}
