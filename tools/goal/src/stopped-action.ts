import type { Database } from 'bun:sqlite';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { preservesTerminalProof } from './owner-decisions.ts';
import { defaultPolicy } from './policy.ts';
import type { WorkerEvent } from './store.ts';
import type { Task } from './types.ts';
import { nativeCheckId, observeOrdinaryProof } from './verification.ts';

export type StoppedActionHint = 'actionable' | 'preserved' | 'inspect-proof';

/** Compact indexed facts for a stopped row. Only a legacy preservation decision needs a receipt read. */
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
  return `(SELECT CASE
    WHEN json_extract(a.body, '$.terminationIntent.operation')='stop'
      AND coalesce(json_extract(a.body, '$.terminationIntent.requestedAt'), '')!='' THEN 'preserved'
    WHEN json_extract(a.body, '$.terminationIntent.operation')='cancel' AND (
      coalesce(json_extract(a.body, '$.terminationIntent.state'), '')!='complete' OR
      coalesce(json_extract(a.body, '$.terminationIntent.settledAt'), '')=''
    ) THEN 'preserved'
    WHEN coalesce(json_extract(s.body, '$.brief.kind'), '')!='verification' THEN 'actionable'
    ${verificationDecision}
    ELSE 'actionable' END
    FROM worker_tasks s LEFT JOIN worker_attempts a ON a.task_id=s.id AND a.attempt=s.current_attempt
    WHERE s.id=${taskId} AND s.current_attempt=${attempt})`;
}

export function isActionableStop(
  db: Database,
  taskId: string,
  attempt: number,
  hint: StoppedActionHint | null,
  policy = defaultPolicy,
): boolean {
  if (hint !== 'inspect-proof') return hint !== 'preserved';
  try {
    const row = db
      .query<{ task: string; checks: string | null }, [string, number]>(
        `SELECT t.body AS task, json_extract(a.body, '$.checks') AS checks
       FROM worker_tasks t JOIN worker_attempts a ON a.task_id=t.id AND a.attempt=t.current_attempt
       WHERE t.id=? AND t.current_attempt=?`,
      )
      .get(taskId, attempt);
    if (!row || !row.checks) return true;
    const task = JSON.parse(row.task) as Task;
    if (
      task.id !== taskId ||
      task.currentAttempt !== attempt ||
      task.state !== 'stopped' ||
      task.brief.kind !== 'verification'
    )
      return true;
    const events = db
      .query<WorkerEvent, [string, number]>(
        `SELECT sequence,task_id,attempt,kind,at,body FROM worker_events WHERE task_id=? AND attempt<=?
       AND kind IN ('owner-contract-decision-accepted','owner-contract-decisions-superseded') ORDER BY sequence`,
      )
      .all(taskId, attempt);
    if (!preservesTerminalProof(events, task, { taskId, attempt }, policy)) return true;
    const checks: unknown = JSON.parse(row.checks);
    if (
      !Array.isArray(checks) ||
      checks.length !== 1 ||
      typeof checks[0] !== 'string' ||
      !nativeCheckId.test(checks[0])
    )
      return true;
    const path = join(task.worktree, '.temp/goal/checks/results', `${checks[0]}.json`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > policy.proof.sourceBufferBytes) return true;
    return observeOrdinaryProof(task, checks[0], JSON.parse(readFileSync(path, 'utf8'))).status !== 'terminal';
  } catch {
    // No unverifiable owner decision or result silently suppresses an ordinary action.
    return true;
  }
}
