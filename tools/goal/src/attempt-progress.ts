import { spawnSync } from 'node:child_process';
import type { AttemptRef } from './contracts.ts';
import type { WorkerStore } from './store.ts';
import type { Attempt, Settings, Task } from './types.ts';

/**
 * Retry delays for a tool blocker by how often its fingerprint was seen across all tasks in the last hour: the first
 * sighting waits two minutes, the second ten, later ones thirty. Zero-delay retries repeated the same blocker 176 times
 * within five minutes (2026-11-01).
 */
export const TOOL_RETRY_BACKOFF_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000] as const;
const BACKOFF_WINDOW_MS = 60 * 60_000;
/** The backoff count reads only recent event rows, so its cost does not grow with the store's history. */
const BACKOFF_EVENT_ROWS = 5_000;

/** Test processes retry at once unless a test sets its own delays. */
export function toolRetryBackoff(settings: Pick<Settings, 'toolRetryBackoffMs'>): readonly number[] {
  return (
    settings.toolRetryBackoffMs ??
    (process.env.REZICS_GOAL_TEST_ENVIRONMENT === '1' ? [0, 0, 0] : TOOL_RETRY_BACKOFF_MS)
  );
}

/** The task branch's commit; null for a shared workspace or a branch Git cannot read. */
export function branchHead(task: Pick<Task, 'worktree' | 'branch'> & Partial<Pick<Task, 'workspace'>>): string | null {
  if (task.workspace || !task.worktree || !task.branch) return null;
  const result = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${task.branch}^{commit}`], {
    cwd: task.worktree,
    encoding: 'utf8',
  });
  const head = result.status === 0 ? result.stdout.trim() : '';
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(head) ? head : null;
}

function uncommittedWork(worktree: string): boolean | null {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim().length > 0 : null;
}

/** True when the head moved or work is uncommitted; null when a needed Git observation failed. */
function observedProgress(
  startHead: string | null,
  endHead: string | null,
  uncommitted: boolean | null,
): boolean | null {
  if (!startHead || !endHead) return null;
  if (startHead !== endHead || uncommitted === true) return true;
  return uncommitted === false ? false : null;
}

function parse(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The progress recorded when the attempt ended; null when it was not recorded or was unknown. */
export function recordedProgress(store: WorkerStore, ref: AttemptRef): boolean | null {
  const event = store.events(ref.taskId, ref.attempt).find((candidate) => candidate.kind === 'attempt-progress');
  const progress = event ? parse(event.body).progress : null;
  return typeof progress === 'boolean' ? progress : null;
}

/**
 * Whether the attempt changed its branch: the branch head moved since the attempt's first prompt, or work is left
 * uncommitted (the next attempt commits it). Measured once, when the attempt's failure is classified, and recorded,
 * because a retry rebases the branch afterwards. Null when either head is unknown, or heads match and git status
 * failed.
 */
export function attemptProgress(store: WorkerStore, task: Task, ref: AttemptRef): boolean | null {
  if (store.events(ref.taskId, ref.attempt).some((event) => event.kind === 'attempt-progress'))
    return recordedProgress(store, ref);
  const started = store.events(ref.taskId, ref.attempt).find((event) => event.kind === 'worker-run-started');
  const recordedStart = started ? parse(started.body).branchHead : undefined;
  const startHead = typeof recordedStart === 'string' ? recordedStart : null;
  const endHead = branchHead(task);
  const uncommitted = startHead && endHead ? uncommittedWork(task.worktree) : null;
  const progress = observedProgress(startHead, endHead, uncommitted);
  store.event(ref, 'attempt-progress', { startHead, endHead, uncommitted, progress });
  return progress;
}

/**
 * This attempt and the one before it both ended without a new commit. Records this attempt's progress for the next
 * one. Unknown progress never counts.
 */
export function noProgressTwice(store: WorkerStore, task: Task, ref: AttemptRef): boolean {
  if (attemptProgress(store, task, ref) !== false || ref.attempt < 2) return false;
  return recordedProgress(store, { taskId: ref.taskId, attempt: ref.attempt - 1 }) === false;
}

/** A tool blocker's identity: its first line with its worktree and volatile numbers, hashes and identifiers removed. */
export function blockerFingerprint(attempt: Pick<Attempt, 'blocker' | 'result'>, worktree?: string | null): string {
  const line = (attempt.blocker || attempt.result || '').split(/\r?\n/, 1)[0] ?? '';
  const withoutWorktree = worktree
    ? line.replace(
        new RegExp(escapeRegExp(worktree.replaceAll('\\', '/')).replaceAll('/', '[\\\\/]'), 'gi'),
        '<worktree>',
      )
    : line;
  return (
    withoutWorktree
      .replace(/\x1b\[[0-9;]*m/g, '')
      // Temporary directory names are random per run; the same failure must keep one fingerprint.
      .replace(/(\/(?:tmp|var\/tmp|run\/user\/\d+)\/[A-Za-z0-9._-]*?)[-.]?[A-Za-z0-9]{6,}(?=[\/'"\s]|$)/g, '$1<tmp>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
      .replace(/\b[0-9a-f]{7,}\b/gi, '#')
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .slice(0, 300)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The delay before retrying a tool blocker with this fingerprint; records the sighting for later retries. */
export function toolRetryDelay(
  store: WorkerStore,
  settings: Pick<Settings, 'toolRetryBackoffMs'>,
  ref: AttemptRef,
  fingerprint: string,
  now = Date.now(),
): number {
  const ladder = toolRetryBackoff(settings);
  const since = new Date(now - BACKOFF_WINDOW_MS).toISOString();
  const rows = store.db
    .query(
      `SELECT body FROM worker_events
        WHERE sequence > (SELECT COALESCE(MAX(sequence), 0) FROM worker_events) - ?
          AND kind = 'tool-blocker-retry' AND at >= ?`,
    )
    .all(BACKOFF_EVENT_ROWS, since) as { body: string }[];
  const seen = rows.filter((row) => parse(row.body).fingerprint === fingerprint).length;
  const delayMs = ladder[Math.min(seen, ladder.length - 1)] ?? 0;
  store.event(ref, 'tool-blocker-retry', { fingerprint, seen, delayMs });
  return delayMs;
}
