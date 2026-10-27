import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_HOST_TRANSPORT, MODEL_AT_CAPACITY, POOL_EXHAUSTED } from './records.ts';
import type { WorkerStore } from './store.ts';

// Each check is a state the control plane should never stay in. A violation that persists means work has silently
// stopped, which nobody notices from the inside: on 2026-10-26 eight tasks sat in running without a worker for up to
// three hours, and stabilize stopped reaching dev for over two hours, before anyone looked.

/** How long a violation may last before the supermanager is told, and how often it is told again. */
const NO_WORKER_MS = 10 * 60_000;
const STABILIZE_BEHIND_MS = 30 * 60_000;
const ALERT_EVERY_MS = 2 * 3_600_000;
const FAILURE_WINDOW_MS = 30 * 60_000;
const HOST_PROBE_EVERY_MS = 5 * 60_000;
const HOST_PROBE_TIMEOUT_MS = 20_000;

type CheckHost = { name: string; address: string; identity: string };
export type CheckHostProbeResult = { status: number | null; stderr: string };
export type CheckHostProbe = (host: CheckHost) => CheckHostProbeResult;
type State = {
  alerts: Record<string, string>;
  stabilizeBehindSince?: string;
  lastHostProbeAt?: string;
  hostProbeFailures?: Record<string, number>;
};

const SIGNATURES = [
  { name: 'check-host transport', pattern: CHECK_HOST_TRANSPORT },
  { name: 'model capacity', pattern: MODEL_AT_CAPACITY },
  { name: 'allowance exhausted', pattern: POOL_EXHAUSTED },
  { name: 'file watchers exhausted', pattern: /EMFILE/i },
  { name: 'out of memory or disk', pattern: /ENOSPC|ENOMEM|\bKilled\b|out of memory/i },
  { name: 'lease or lock timeouts', pattern: /Lease held|lease.*timeout|lock.*timeout|timeout.*(?:lease|lock)/i },
  {
    name: 'remote slot waits',
    pattern:
      /remote-check:.*(?:slot.*wait|wait.*slot)|waiting for (?:a |every )?(?:remote )?(?:check )?slot|Waiting for host capacity/i,
  },
] as const;

function sshProbe(host: CheckHost): CheckHostProbeResult {
  const result = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', host.identity, host.address, 'true'],
    { encoding: 'utf8', timeout: HOST_PROBE_TIMEOUT_MS },
  );
  return {
    status: result.status,
    stderr: result.stderr || result.error?.message || (result.status === null ? 'SSH probe failed' : ''),
  };
}

function checkHosts(stateDirectory: string): CheckHost[] {
  const path = join(stateDirectory, 'remote-check-hosts.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { hosts?: unknown };
    if (!Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.filter(
      (host): host is CheckHost =>
        typeof host === 'object' &&
        host !== null &&
        typeof (host as CheckHost).name === 'string' &&
        Boolean((host as CheckHost).name) &&
        typeof (host as CheckHost).address === 'string' &&
        /^[\w.-]+@[\w.:-]+$/.test((host as CheckHost).address) &&
        typeof (host as CheckHost).identity === 'string' &&
        Boolean((host as CheckHost).identity),
    );
  } catch {
    return [];
  }
}

function failureSignature(error: string): (typeof SIGNATURES)[number] | undefined {
  return SIGNATURES.find((signature) => signature.pattern.test(error));
}

function failureIncidents(
  store: Pick<WorkerStore, 'attemptsEndedBetween'>,
  tasks: ReturnType<WorkerStore['tasks']>,
  now: number,
): { key: string; summary: string }[] {
  const start = new Date(now - FAILURE_WINDOW_MS).toISOString();
  const end = new Date(now).toISOString();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const grouped = new Map<
    string,
    { name: string; attempts: { taskId: string; attempt: number; goal: string; error: string }[] }
  >();
  for (const attempt of store.attemptsEndedBetween(start, end)) {
    const result = typeof attempt.result === 'string' ? attempt.result : '';
    const blocker = typeof attempt.blocker === 'string' ? attempt.blocker : '';
    const error = [result, blocker].filter(Boolean).join('\n');
    const signature = failureSignature(error);
    if (!signature) continue;
    const group = grouped.get(signature.name) ?? { name: signature.name, attempts: [] };
    const exampleError = [result, blocker].find((text) => text && signature.pattern.test(text)) ?? error;
    group.attempts.push({
      taskId: attempt.taskId,
      attempt: attempt.attempt,
      goal: taskById.get(attempt.taskId)?.brief.goal ?? attempt.taskId,
      error: exampleError
        .slice(0, 200)
        .replace(/[\r\n\t]/g, ' ')
        .trim(),
    });
    grouped.set(signature.name, group);
  }
  const found: { key: string; summary: string }[] = [];
  for (const [key, group] of grouped) {
    const taskIds = [...new Set(group.attempts.map((attempt) => attempt.taskId))].sort();
    if (group.attempts.length < 3 || taskIds.length < 2) continue;
    const goals = [...new Set(group.attempts.map((attempt) => attempt.goal))].sort();
    const example = group.attempts[0]!;
    found.push({
      key: `failure-signature:${key}`,
      summary:
        `Incident: ${group.name}: ${group.attempts.length} attempts of ${taskIds.length} tasks in 30 min ` +
        `(${goals.join(', ')}), e.g. ${example.taskId} attempt ${example.attempt}: ${example.error}`,
    });
  }
  return found;
}

function probeCheckHosts(state: State, stateDirectory: string, now: number, probe: CheckHostProbe): string[] {
  const hosts = checkHosts(stateDirectory);
  if (!hosts.length) return [];
  const last = state.lastHostProbeAt ? Date.parse(state.lastHostProbeAt) : Number.NaN;
  if (Number.isFinite(last) && now - last < HOST_PROBE_EVERY_MS) return [];
  const failures = (state.hostProbeFailures ??= {});
  const incidents: string[] = [];
  for (const host of hosts) {
    let result: CheckHostProbeResult;
    try {
      result = probe(host);
    } catch (error) {
      result = { status: null, stderr: error instanceof Error ? error.message : String(error) };
    }
    if (result.status === 0) {
      delete failures[host.name];
      continue;
    }
    const previous = failures[host.name] ?? 0;
    failures[host.name] = Math.min(previous + 1, 2);
    if (previous < 2 && failures[host.name] === 2) {
      const firstLine = (result.stderr || 'SSH probe failed')
        .replaceAll(host.identity, '[identity]')
        .split(/\r?\n/, 1)[0]!
        .trim();
      incidents.push(`Incident: check host ${host.name.replace(/[\r\n]/g, ' ')} refuses SSH: ${firstLine}`);
    }
  }
  state.lastHostProbeAt = new Date(now).toISOString();
  state.hostProbeFailures = failures;
  return incidents;
}

function isAncestor(checkout: string, ancestor: string, descendant: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: checkout }).status === 0;
}

function head(checkout: string, branch: string): string | undefined {
  const result = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], {
    cwd: checkout,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The violations present now, keyed so that one violation is reported once per period. */
export function violations(
  store: Pick<WorkerStore, 'tasks' | 'attempt' | 'retryIntents'>,
  now: number,
  tasks = store.tasks(),
): { key: string; summary: string }[] {
  const found: { key: string; summary: string }[] = [];
  const pending = new Set(
    store
      .retryIntents()
      .filter((intent) => intent.status === 'pending')
      .map((intent) => `${intent.taskId}:${intent.attempt}`),
  );
  for (const task of tasks) {
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
  store: Pick<WorkerStore, 'tasks' | 'attempt' | 'retryIntents' | 'attemptsEndedBetween'>,
  checkout: string,
  branches: { stabilize: string; integration: string },
  stateDirectory: string,
  deliver: (summary: string) => void,
  now = Date.now(),
  probe: CheckHostProbe = sshProbe,
): number {
  const path = join(stateDirectory, 'watchdog.json');
  let state: State = { alerts: {} };
  try {
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<State>;
      state = { ...saved, alerts: saved.alerts ?? {} };
    }
  } catch {
    /* Alert again rather than never. */
  }
  const tasks = store.tasks();
  const found = [...violations(store, now, tasks), ...failureIncidents(store, tasks, now)];
  const hostIncidents = probeCheckHosts(state, stateDirectory, now, probe);
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
    deliver(violation.key.startsWith('failure-signature:') ? violation.summary : `Watchdog: ${violation.summary}`);
    state.alerts[violation.key] = new Date(now).toISOString();
    count++;
  }
  for (const incident of hostIncidents) {
    deliver(incident);
    count++;
  }
  // Forget alerts for violations that ended.
  const live = new Set(found.map((violation) => violation.key));
  for (const key of Object.keys(state.alerts)) if (!live.has(key)) delete state.alerts[key];
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${path}.tmp`, path);
  return count;
}
