import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerStore } from './store.ts';

// Each check is a state the control plane should never stay in. A violation that persists means work has silently
// stopped, which nobody notices from the inside: on 2026-10-26 eight tasks sat in running without a worker for up to
// three hours, and stabilize stopped reaching dev for over two hours, before anyone looked.

/** How long a violation may last before the supermanager is told, and how often it is told again. */
const NO_WORKER_MS = 10 * 60_000;
const STABILIZE_BEHIND_MS = 30 * 60_000;
const ALERT_EVERY_MS = 2 * 3_600_000;

type State = { alerts: Record<string, string>; stabilizeBehindSince?: string };

function isAncestor(checkout: string, ancestor: string, descendant: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: checkout }).status === 0;
}

function head(checkout: string, branch: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: checkout, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The violations present now, keyed so that one violation is reported once per period. */
export function violations(
  store: Pick<WorkerStore, 'tasks' | 'attempt' | 'retryIntents'>,
  now: number,
): { key: string; summary: string }[] {
  const found: { key: string; summary: string }[] = [];
  const pending = new Set(
    store
      .retryIntents()
      .filter((intent) => intent.status === 'pending')
      .map((intent) => `${intent.taskId}:${intent.attempt}`),
  );
  for (const task of store.tasks()) {
    if (!task.currentAttempt || !['running', 'ready'].includes(task.state)) continue;
    const attempt = store.attempt({ taskId: task.id, attempt: task.currentAttempt });
    if (attempt.state !== 'exited' || !attempt.endedAt) continue;
    const idle = now - Date.parse(attempt.endedAt);
    if (idle < NO_WORKER_MS) continue;
    const intent = pending.has(`${task.id}:${attempt.attempt}`);
    if (task.state === 'ready' && !intent) continue;
    const minutes = Math.round(idle / 60_000);
    found.push({
      key: `no-worker:${task.id}:${attempt.attempt}`,
      summary: intent
        ? `Task ${task.id} (${task.brief.goal}) has had a pending retry for ${minutes} min that no process started.`
        : `Task ${task.id} (${task.brief.goal}) is ${task.state} but its attempt ${attempt.attempt} ended ${minutes} min ago and nothing will start another.`,
    });
  }
  return found;
}

/** Report violations to the supermanager; returns how many were delivered. */
export function watch(
  store: Pick<WorkerStore, 'tasks' | 'attempt' | 'retryIntents'>,
  checkout: string,
  branches: { stabilize: string; integration: string },
  stateDirectory: string,
  deliver: (summary: string) => void,
  now = Date.now(),
): number {
  const path = join(stateDirectory, 'watchdog.json');
  let state: State = { alerts: {} };
  try {
    if (existsSync(path)) state = JSON.parse(readFileSync(path, 'utf8')) as State;
  } catch {
    /* Alert again rather than never. */
  }
  const found = violations(store, now);
  const stabilize = head(checkout, branches.stabilize);
  const dev = head(checkout, branches.integration);
  if (stabilize && dev && !isAncestor(checkout, stabilize, dev)) {
    state.stabilizeBehindSince ??= new Date(now).toISOString();
    const behind = now - Date.parse(state.stabilizeBehindSince);
    if (behind >= STABILIZE_BEHIND_MS)
      found.push({
        key: `stabilize-behind:${state.stabilizeBehindSince}`,
        summary:
          `${branches.integration} has not contained ${branches.stabilize} for ${Math.round(behind / 60_000)} min ` +
          `(since ${state.stabilizeBehindSince}): fixes on ${branches.stabilize} are not reaching workers. Resolve the ` +
          `${branches.stabilize}-to-${branches.integration} merge.`,
      });
  } else delete state.stabilizeBehindSince;
  let count = 0;
  for (const violation of found) {
    const last = state.alerts[violation.key] ? Date.parse(state.alerts[violation.key]!) : 0;
    if (now - last < ALERT_EVERY_MS) continue;
    deliver(`Watchdog: ${violation.summary}`);
    state.alerts[violation.key] = new Date(now).toISOString();
    count++;
  }
  // Forget alerts for violations that ended.
  const live = new Set(found.map((violation) => violation.key));
  for (const key of Object.keys(state.alerts)) if (!live.has(key)) delete state.alerts[key];
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${path}.tmp`, path);
  return count;
}
