import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { sameProcess } from './process.ts';
import { CHECK_HOST_TRANSPORT, MODEL_AT_CAPACITY, POOL_EXHAUSTED } from './records.ts';
import type { WorkerStore } from './store.ts';
import type { Attempt, Task } from './types.ts';
import type { ManagerEventKind } from './contracts.ts';
import { checkWaitMs } from './launch.ts';

// Each check is a state the control plane should never stay in. A violation that persists means work has silently
// stopped, which nobody notices from the inside: on 2026-10-26 eight tasks sat in running without a worker for up to
// three hours, and stabilize stopped reaching dev for over two hours, before anyone looked.

/** How long a violation may last before the supermanager is told, and how often it is told again. */
const NO_WORKER_MS = 10 * 60_000;
const STABILIZE_BEHIND_MS = 30 * 60_000;
const ALERT_EVERY_MS = 2 * 3_600_000;
const FAILURE_WINDOW_MS = 30 * 60_000;
const HOST_PROBE_EVERY_MS = 5 * 60_000;
const DEFAULT_ATTEMPT_LIMIT_MS = 2 * 60 * 60_000;
const RECENT_COMMANDS = 10;

type CheckHost = { name: string; address: string; identity: string };
export type CheckHostProbeResult = { status: number | null; stderr: string };
export type CheckHostProbe = (host: CheckHost, complete: (result: CheckHostProbeResult) => void) => void;
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

let nextProbeRun = 0;
const currentProbeRuns = new Map<string, number>();

function firstLine(stderr: string): string {
  return stderr.split(/\r?\n/, 1)[0]!.trim();
}

function probeFile(stateDirectory: string, host: CheckHost): string {
  return join(stateDirectory, 'host-probes', `${encodeURIComponent(host.name)}.json`);
}

function invalidateRemovedProbeRuns(directory: string, retainedPaths: Set<string>): void {
  const prefix = `${directory}${sep}`;
  for (const path of currentProbeRuns.keys()) {
    if (path.startsWith(prefix) && !retainedPaths.has(path)) currentProbeRuns.delete(path);
  }
}

export function sshProbe(host: CheckHost, complete: (result: CheckHostProbeResult) => void, start = spawn): void {
  let child: ReturnType<typeof spawn>;
  try {
    child = start(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', host.identity, host.address, 'true'],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (error) {
    complete({ status: null, stderr: error instanceof Error ? error.message : String(error) });
    return;
  }

  let stderr = '';
  let hasFirstLine = false;
  let spawnError = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (hasFirstLine) return;
    const text = chunk.toString();
    const newline = text.search(/[\r\n]/);
    stderr += newline < 0 ? text : text.slice(0, newline);
    hasFirstLine = newline >= 0;
  });
  child.once('error', (error) => {
    spawnError = error.message;
  });
  child.once('close', (status) => {
    complete({
      status,
      stderr: firstLine(stderr) || spawnError || (status === null ? 'SSH probe failed' : ''),
    });
  });
  child.unref();
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

function reportsBlocked(result: string): boolean {
  let end = result.lastIndexOf('}');
  while (end >= 0) {
    let start = result.lastIndexOf('{', end);
    while (start >= 0) {
      try {
        const value = JSON.parse(result.slice(start, end + 1));
        if (value && typeof value === 'object' && 'status' in value) return value.status === 'blocked';
      } catch {
        /* A result can wrap its final status object in prose. */
      }
      if (start === 0) break;
      start = result.lastIndexOf('{', start - 1);
    }
    if (end === 0) break;
    end = result.lastIndexOf('}', end - 1);
  }
  return false;
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
    if (!attempt.failureKind && !reportsBlocked(result)) continue;
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

function recentCommands(attempt: Attempt): string[] {
  try {
    return readFileSync(attempt.logPath, 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as Record<string, any>;
          const payload = event.payload ?? event;
          const item = event.item ?? payload;
          if (item.type === 'command_execution' && typeof item.command === 'string') return [item.command.trim()];
          if (event.type === 'assistant')
            return (event.message?.content ?? []).flatMap((part: Record<string, any>) =>
              part.type === 'tool_use' && typeof part.input?.command === 'string' ? [part.input.command.trim()] : [],
            );
          if (payload.type === 'function_call' && typeof (payload.arguments ?? payload.input) === 'string')
            return [String(payload.arguments ?? payload.input).trim()];
          return [];
        } catch {
          return [];
        }
      })
      .filter(Boolean)
      .slice(-RECENT_COMMANDS);
  } catch {
    return [];
  }
}

function elapsedText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function commitCount(task: Task): number {
  const result = spawnSync('git', ['-C', task.worktree, 'rev-list', '--count', `${task.base}..HEAD`], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const count = Number(result.stdout?.trim());
  return result.status === 0 && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function longAttemptIncidents(
  store: Pick<WorkerStore, 'attempt'>,
  tasks: Task[],
  now: number,
  limitFor: (task: Task) => number,
): { key: string; managerId: string; kind: ManagerEventKind; summary: string }[] {
  const found: { key: string; managerId: string; kind: ManagerEventKind; summary: string }[] = [];
  for (const task of tasks) {
    if (task.state !== 'running' || task.currentAttempt < 1) continue;
    let attempt: Attempt;
    try {
      attempt = store.attempt({ taskId: task.id, attempt: task.currentAttempt });
    } catch {
      continue;
    }
    if (!attempt || attempt.state !== 'running') continue;
    const elapsed = now - Date.parse(attempt.startedAt);
    if (!Number.isFinite(elapsed)) continue;
    const commands = recentCommands(attempt);
    const waitsForCheck = commands.some((command) => /(?:^|[\s/])worker-check\.ts\b/.test(command));
    const common = `task ${task.id} attempt ${attempt.attempt} has run ${elapsedText(elapsed)}, with ${commitCount(task)} commits and ${elapsedText(checkWaitMs(attempt.logPath))} spent waiting for check slots`;
    if (elapsed >= Math.max(1, limitFor(task)))
      found.push({
        key: `long-attempt:${task.id}:${attempt.attempt}`,
        managerId: task.brief.manager,
        kind: 'stalled',
        summary: `Long attempt: ${common}; last ${commands.length} commands: ${commands.length ? commands.join(' | ') : '(none recorded)'}`,
      });
    const processCommands = commands.filter((command) => /(?:^|[;&|]\s*)(?:\S*\/)?(?:ps|pgrep)(?:\s|$)/.test(command));
    if (!waitsForCheck && processCommands.length >= 2)
      found.push({
        key: `attempt-polling:${task.id}:${attempt.attempt}`,
        managerId: task.brief.manager,
        kind: 'stalled',
        summary: `Polling: ${common}; recent commands repeatedly inspect processes (${processCommands.join(' | ')}) instead of waiting through scripts/worker-check.ts`,
      });
  }
  return found;
}

function savedProbeResult(path: string, sweepAt: string): CheckHostProbeResult | undefined {
  try {
    const result = JSON.parse(readFileSync(path, 'utf8')) as Partial<CheckHostProbeResult> & { sweepAt?: unknown };
    if (
      result.sweepAt === sweepAt &&
      (typeof result.status === 'number' || result.status === null) &&
      typeof result.stderr === 'string'
    )
      return { status: result.status, stderr: result.stderr };
  } catch {
    /* A missing, incomplete or malformed result is not a failed probe. */
  }
  return undefined;
}

function writeProbeResult(path: string, result: CheckHostProbeResult, sweepAt: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ status: result.status, stderr: result.stderr, sweepAt }));
    renameSync(temporary, path);
  } catch {
    /* If the result cannot be saved, the next sweep treats it as no result. */
  }
}

function probeCheckHosts(state: State, stateDirectory: string, now: number, probe: CheckHostProbe): string[] {
  const hosts = checkHosts(stateDirectory);
  const directory = join(stateDirectory, 'host-probes');
  if (!hosts.length) {
    delete state.lastHostProbeAt;
    invalidateRemovedProbeRuns(directory, new Set());
    return [];
  }
  const last = state.lastHostProbeAt ? Date.parse(state.lastHostProbeAt) : Number.NaN;
  if (Number.isFinite(last) && now - last < HOST_PROBE_EVERY_MS) return [];
  const failures = (state.hostProbeFailures ??= {});
  const incidents: string[] = [];
  const retainedPaths = new Set(hosts.map((host) => probeFile(stateDirectory, host)));
  invalidateRemovedProbeRuns(directory, retainedPaths);
  const hasPreviousSweep = Number.isFinite(last);
  const previousSweepAt = state.lastHostProbeAt;
  for (const host of hosts) {
    const result = hasPreviousSweep ? savedProbeResult(probeFile(stateDirectory, host), previousSweepAt!) : undefined;
    if (!result) continue;
    if (result.status === 0) {
      delete failures[host.name];
      continue;
    }
    const previous = failures[host.name] ?? 0;
    failures[host.name] = Math.min(previous + 1, 2);
    if (previous < 2 && failures[host.name] === 2) {
      const message = (result.stderr || 'SSH probe failed').replaceAll(host.identity, '[identity]').trim();
      incidents.push(`Incident: check host ${host.name.replace(/[\r\n]/g, ' ')} refuses SSH: ${message}`);
    }
  }

  mkdirSync(directory, { recursive: true });
  try {
    for (const name of readdirSync(directory)) if (name.endsWith('.json')) unlinkSync(join(directory, name));
  } catch {
    /* Missing or unreadable result files simply produce no result on the next sweep. */
  }
  const sweepAt = new Date(now).toISOString();
  for (const host of hosts) {
    const path = probeFile(stateDirectory, host);
    const run = ++nextProbeRun;
    currentProbeRuns.set(path, run);
    let completed = false;
    const complete = (result: CheckHostProbeResult) => {
      if (completed) return;
      completed = true;
      if (currentProbeRuns.get(path) !== run) return;
      writeProbeResult(
        path,
        {
          status: result.status,
          stderr: firstLine(result.stderr).replaceAll(host.identity, '[identity]'),
        },
        sweepAt,
      );
    };
    try {
      probe(host, complete);
    } catch (error) {
      complete({ status: null, stderr: error instanceof Error ? error.message : String(error) });
    }
  }
  state.lastHostProbeAt = sweepAt;
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
    if (attempt.driver && sameProcess(attempt.driver)) continue;
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
  deliver: (summary: string, managerId?: string, kind?: ManagerEventKind) => void,
  now = Date.now(),
  probe: CheckHostProbe = sshProbe,
  limitFor: (task: Task) => number = () => DEFAULT_ATTEMPT_LIMIT_MS,
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
  const longAttempts = longAttemptIncidents(store, tasks, now, limitFor);
  const found = [...violations(store, now, tasks), ...failureIncidents(store, tasks, now), ...longAttempts];
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
    const attemptAlert = longAttempts.find((alert) => alert.key === violation.key);
    const last = state.alerts[violation.key] ? Date.parse(state.alerts[violation.key]!) : 0;
    if (attemptAlert ? state.alerts[violation.key] !== undefined : now - last < ALERT_EVERY_MS) continue;
    deliver(
      attemptAlert
        ? violation.summary
        : violation.key.startsWith('failure-signature:')
          ? violation.summary
          : `Watchdog: ${violation.summary}`,
      attemptAlert?.managerId,
      attemptAlert?.kind,
    );
    state.alerts[violation.key] = new Date(now).toISOString();
    count++;
  }
  for (const incident of hostIncidents) {
    deliver(incident);
    count++;
  }
  // Forget alerts for violations that ended.
  const live = new Set(found.map((violation) => violation.key));
  const activeAttempts = new Set(
    tasks
      .filter((task) => task.state === 'running' && task.currentAttempt > 0)
      .map((task) => `${task.id}:${task.currentAttempt}`),
  );
  for (const key of Object.keys(state.alerts)) {
    const activeAlert = /^(?:long-attempt|attempt-polling):(.+)$/.exec(key);
    if (!live.has(key) && (!activeAlert || !activeAttempts.has(activeAlert[1]!))) delete state.alerts[key];
  }
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${path}.tmp`, path);
  return count;
}
