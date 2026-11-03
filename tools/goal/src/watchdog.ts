import { agentAdapter, agentCommands, allAgentAdapters, parseAgentExit } from './agents.ts';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { sameProcess } from './process.ts';
import { CHECK_HOST_TRANSPORT, readLogTail } from './records.ts';
import type { WorkerStore } from './store.ts';
import type { Attempt, RetryIntent, Task } from './types.ts';
import type { ManagerEventKind } from './contracts.ts';
import { capacityWaiters, checkWaitMs } from './launch.ts';

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
const HOST_PROBE_DIAGNOSTIC_LIMIT = 4 * 1024;
const DEFAULT_ATTEMPT_LIMIT_MS = 2 * 60 * 60_000;
const RECENT_COMMANDS = 10;

type CheckHost = { name: string; address: string; identity: string };
export type CheckHostProbeResult = { status: number | null; stderr: string };
export type CheckHostProbe = (host: CheckHost, complete: (result: CheckHostProbeResult) => void) => void;
type State = {
  alerts: Record<string, string>;
  longAttemptReports?: Record<string, { at: string; command: string; commits: number }>;
  stabilizeBehindSince?: string;
  lastHostProbeAt?: string;
  hostProbeFailures?: Record<string, number>;
};

const SIGNATURES = [
  { name: 'check-host transport', pattern: CHECK_HOST_TRANSPORT },
  {
    name: 'model capacity',
    pattern: { test: (text: string) => allAgentAdapters().some((adapter) => adapter.signals?.(text).capacity) },
  },
  {
    name: 'allowance exhausted',
    pattern: { test: (text: string) => allAgentAdapters().some((adapter) => adapter.signals?.(text).allowance) },
  },
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

export function sshProbe(
  host: CheckHost,
  complete: (result: CheckHostProbeResult) => void,
  start = spawn,
  timeoutMs = HOST_PROBE_TIMEOUT_MS,
): void {
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
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (result: CheckHostProbeResult) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    complete(result);
  };
  const fail = () =>
    settle({
      status: null,
      stderr: firstLine(stderr) || spawnError || 'SSH probe failed',
    });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (settled || hasFirstLine) return;
    const text = chunk.toString();
    const newline = text.search(/[\r\n]/);
    const piece = newline < 0 ? text : text.slice(0, newline);
    const remaining = HOST_PROBE_DIAGNOSTIC_LIMIT - stderr.length;
    if (remaining <= 0) {
      hasFirstLine = true;
      return;
    }
    stderr += piece.length > remaining ? piece.slice(0, remaining) : piece;
    hasFirstLine = newline >= 0 || stderr.length >= HOST_PROBE_DIAGNOSTIC_LIMIT;
  });
  child.once('error', (error) => {
    if (settled) return;
    spawnError = error.message;
  });
  child.once('close', (status) => {
    settle({
      status,
      stderr: firstLine(stderr) || spawnError || (status === null ? 'SSH probe failed' : ''),
    });
  });
  timer = setTimeout(() => {
    fail();
    try {
      child.kill();
    } catch {
      /* This probe's child may already have exited. */
    }
  }, timeoutMs);
  timer.unref();
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

function reportsBlocked(result: string, attempt: Attempt): boolean {
  const exit = parseAgentExit(result, attempt.profile?.cli ? agentAdapter(attempt.profile.cli) : undefined) as {
    status?: unknown;
  } | null;
  return exit?.status === 'blocked';
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
    if (!attempt.failureKind && !reportsBlocked(result, attempt)) continue;
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
  return agentCommands(
    readLogTail(attempt.logPath),
    attempt.profile?.cli ? agentAdapter(attempt.profile.cli) : undefined,
  ).slice(-RECENT_COMMANDS);
}

function elapsedText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function inspectsProcesses(command: string): boolean {
  // A command can include the shell launcher around the requested script.
  const shell = /^(?:\S*\/)?(?:ba|z)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/.exec(command);
  const script = shell?.[2] ?? command;
  return /(?:^|[;&|\n])\s*(?:\S*\/)?(?:ps|pgrep)(?:\s|$)/.test(script);
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
): { key: string; managerId: string; kind: ManagerEventKind; summary: string; command?: string; commits?: number }[] {
  const found: {
    key: string;
    managerId: string;
    kind: ManagerEventKind;
    summary: string;
    command?: string;
    commits?: number;
  }[] = [];
  for (const task of tasks) {
    if (task.state !== 'running' || task.currentAttempt < 1) continue;
    let attempt: Attempt;
    try {
      attempt = store.attempt({ taskId: task.id, attempt: task.currentAttempt });
    } catch {
      continue;
    }
    if (!attempt || !['running', 'waiting'].includes(attempt.state)) continue;
    const elapsed = now - Date.parse(attempt.startedAt);
    if (!Number.isFinite(elapsed)) continue;
    const commands = recentCommands(attempt);
    const command = commands.at(-1) ?? '(none recorded)';
    const commits = commitCount(task);
    const waitsForCheck = commands.some((command) => /(?:^|[\s/])worker-check\.ts\b/.test(command));
    const longRunning = elapsed >= Math.max(1, limitFor(task));
    const processCommands = commands.filter(inspectsProcesses);
    const polling = !waitsForCheck && processCommands.length >= 2;
    if (longRunning || polling) {
      const common = `task ${task.id} attempt ${attempt.attempt} has run ${elapsedText(elapsed)}, with ${commits} commits and ${elapsedText(checkWaitMs(attempt.logPath))} spent waiting for check slots`;
      if (longRunning)
        found.push({
          key: `long-attempt:${task.id}:${attempt.attempt}`,
          managerId: task.brief.manager,
          kind: 'stalled',
          summary: `Long attempt: ${common}; last ${commands.length} commands: ${commands.length ? commands.join(' | ') : '(none recorded)'}`,
          command,
          commits,
        });
      if (polling)
        found.push({
          key: `attempt-polling:${task.id}:${attempt.attempt}`,
          managerId: task.brief.manager,
          kind: 'stalled',
          summary: `Polling: ${common}; recent commands repeatedly inspect processes (${processCommands.join(' | ')}) instead of waiting through scripts/worker-check.ts`,
        });
    }
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

/**
 * Check hosts whose last two probes failed and have not succeeded since: the watchdog's host outage state. Retries of
 * check-host transport failures wait while this is not empty. Without a hosts file or saved state nothing is out.
 */
export function checkHostsInOutage(stateDirectory: string): string[] {
  try {
    const saved = JSON.parse(readFileSync(join(stateDirectory, 'watchdog.json'), 'utf8')) as Partial<State>;
    const listed = new Set(checkHosts(stateDirectory).map((host) => host.name));
    return Object.entries(saved.hostProbeFailures ?? {})
      .filter(([name, failures]) => listed.has(name) && failures >= 2)
      .map(([name]) => name);
  } catch {
    return [];
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

/**
 * Why a pending retry deliberately does not start yet: unmet `after` dependencies, a backoff time, or a check-host
 * outage it waits out. Null when it is waiting only for a starter or capacity.
 */
export function retryWait(
  intent: RetryIntent,
  task: Pick<Task, 'brief'>,
  dependencyState: (id: string) => string | undefined,
  now: number,
  stateDirectory?: string,
):
  | { reason: 'dependencies'; waitingFor: string[] }
  | { reason: 'backoff'; until: string }
  | { reason: 'check-hosts'; hosts: string[] }
  | null {
  const waitingFor = (task.brief.after ?? []).filter(
    (id) => !['integrated', 'merged'].includes(dependencyState(id) ?? ''),
  );
  if (waitingFor.length) return { reason: 'dependencies', waitingFor };
  const until = intent.options?.notBefore;
  if (until && Date.parse(until) > now) return { reason: 'backoff', until };
  const hosts = intent.options?.awaitCheckHosts && stateDirectory ? checkHostsInOutage(stateDirectory) : [];
  return hosts.length ? { reason: 'check-hosts', hosts } : null;
}

/** The violations present now, keyed so that one violation is reported once per period. */
export function violations(
  store: Pick<WorkerStore, 'attempt' | 'retryIntents'> &
    Partial<Pick<WorkerStore, 'tasks' | 'activeTasks' | 'dependency'>>,
  now: number,
  tasks = store.activeTasks?.() ?? store.tasks?.() ?? [],
  stateDirectory?: string,
): { key: string; summary: string }[] {
  const found: { key: string; summary: string }[] = [];
  const pending = new Map(
    store
      .retryIntents()
      .filter((intent) => intent.status === 'pending')
      .map((intent) => [`${intent.taskId}:${intent.attempt}`, intent] as const),
  );
  const dependencyState = (id: string) => store.dependency?.(id)?.state;
  const waiting = stateDirectory ? capacityWaiters(stateDirectory) : new Set<string>();
  for (const task of tasks) {
    if (!task.currentAttempt || !['running', 'ready'].includes(task.state)) continue;
    const attempt = store.attempt({ taskId: task.id, attempt: task.currentAttempt });
    if (attempt.state !== 'exited' || !attempt.endedAt) continue;
    if (attempt.driver && sameProcess(attempt.driver)) continue;
    const idle = now - Date.parse(attempt.endedAt);
    if (idle < NO_WORKER_MS) continue;
    const retry = pending.get(`${task.id}:${attempt.attempt}`);
    const intent = retry !== undefined;
    if (task.state === 'ready' && !intent) continue;
    if (task.state === 'ready' && intent && waiting.has(task.id)) continue;
    // A retry held for dependencies, a backoff or a host outage is waiting by design, not missing its starter.
    if (retry && retryWait(retry, task, dependencyState, now, stateDirectory)) continue;
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
  store: Pick<WorkerStore, 'attempt' | 'retryIntents' | 'attemptsEndedBetween'> &
    Partial<Pick<WorkerStore, 'tasks' | 'activeTasks' | 'dependency'>>,
  checkout: string,
  branches: { stabilize: string; integration: string },
  stateDirectory: string,
  deliver: (summary: string, managerId?: string, kind?: ManagerEventKind) => void,
  now = Date.now(),
  probe: CheckHostProbe = sshProbe,
  limitFor: (task: Task) => number = () => DEFAULT_ATTEMPT_LIMIT_MS,
): number {
  // A manager event summary must be one line. A worker command holding a newline once made delivery throw before the
  // alert state was saved, so every alert went out again on each sweep.
  const send = deliver;
  deliver = (summary, managerId, kind) => send(summary.replace(/\s*[\r\n]+\s*/g, ' '), managerId, kind);
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
  const tasks = store.activeTasks?.() ?? store.tasks?.() ?? [];
  const longAttempts = longAttemptIncidents(store, tasks, now, limitFor);
  const found = [
    ...violations(store, now, tasks, stateDirectory),
    ...failureIncidents(store, tasks, now),
    ...longAttempts,
  ];
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
    const isLongAttempt = attemptAlert?.key.startsWith('long-attempt:') ?? false;
    const last = state.alerts[violation.key] ? Date.parse(state.alerts[violation.key]!) : 0;
    if (isLongAttempt && attemptAlert) {
      const reports = (state.longAttemptReports ??= {});
      const previous = reports[violation.key];
      // Only new commits are news: a worker alternating wait and tail commands changed the last command every minute
      // and woke its manager 15 times for one attempt (2026-10-29).
      const unchanged = previous !== undefined && previous.commits === attemptAlert.commits;
      const lastReportAt = previous ? Date.parse(previous.at) : Number.NaN;
      if (unchanged && Number.isFinite(lastReportAt) && now - lastReportAt < 60 * 60_000) continue;
      reports[violation.key] = {
        at: new Date(now).toISOString(),
        command: attemptAlert.command ?? '(none recorded)',
        commits: attemptAlert.commits ?? 0,
      };
    } else if (attemptAlert ? state.alerts[violation.key] !== undefined : now - last < ALERT_EVERY_MS) continue;
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
  for (const key of Object.keys(state.longAttemptReports ?? {}))
    if (!live.has(key)) delete state.longAttemptReports![key];
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${path}.tmp`, path);
  return count;
}
