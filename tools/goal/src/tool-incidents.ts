import { statSync } from 'node:fs';
import { defaultPolicy } from './policy.ts';
import { spawnSync } from 'node:child_process';
import type { AttemptRef, ManagerInbox, ManagerEvent } from './contracts.ts';
import { blockerFingerprint } from './attempt-progress.ts';
import { agentAdapter } from './agents.ts';
import { TRANSPORT_FAILURE_EVENT } from './agents/shared.ts';
import { readLogFromOffset } from './records.ts';
import type { WorkerStore } from './store.ts';
import type { Attempt, RetryIntent, Settings, Task } from './types.ts';

export const TOOL_INCIDENT_THRESHOLD = defaultPolicy.toolIncidents.threshold;
export const TOOL_INCIDENT_WINDOW_MS = defaultPolicy.toolIncidents.windowMs;
export const TOOL_INCIDENT_PROBE_MS = defaultPolicy.toolIncidents.probeMs;

const FAILURE_EVENT = 'tool-blocker-incident-failure';
const STATE_EVENT = 'tool-blocker-incident-state';

export type ToolIncident = {
  id: string;
  fingerprint: string;
  line: string;
  errorLine?: string;
  sourceLocation: string;
  openedAt: string;
  updatedAt: string;
  nextProbeAt: string;
  probe: AttemptRef;
  taskIds: string[];
  exampleTasks: Array<{ taskId: string; attempt: number }>;
  noticeDelivered?: boolean;
};

type StoredEvent = {
  sequence: number;
  task_id: string;
  attempt: number;
  at: string;
  body: string;
};

type IncidentResolutionEvidence =
  | {
      kind: 'provider-log-progress';
      probe: AttemptRef;
      failureSequence: number;
      workerRunSequence: number;
      logStartOffset: number;
      observedLogSize: number;
    }
  | {
      kind: 'attempt-ended';
      probe: AttemptRef;
      state: Attempt['state'];
      failureKind: Attempt['failureKind'];
      fingerprint: string | null;
    };

type IncidentState = {
  status: 'open' | 'resolved';
  incident: ToolIncident;
  openingFailureSequence?: number;
  probeRunSequence?: number;
  resolution?: { probe: AttemptRef; evidence: IncidentResolutionEvidence };
};

function parse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function insertEvent(store: WorkerStore, ref: AttemptRef, kind: string, at: string, body: unknown): void {
  store.db
    .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
    .run(ref.taskId, ref.attempt, kind, at, JSON.stringify(body));
}

function currentStates(store: WorkerStore): Map<string, IncidentState> {
  const rows = store.db
    .query(`SELECT sequence, body FROM worker_events WHERE kind=? ORDER BY sequence`)
    .all(STATE_EVENT) as Array<{ sequence: number; body: string }>;
  const states = new Map<string, IncidentState>();
  for (const row of rows) {
    const event = parse<IncidentState>(row.body);
    if (event?.incident?.fingerprint && ['open', 'resolved'].includes(event.status))
      states.set(event.incident.fingerprint, event);
  }
  return states;
}

// A probe task that finished can never run the probe attempt, so its incident would hold retries forever: one held
// six tasks from 02:43 to 08:20 on 2026-11-03 after its probe task integrated on a later attempt.
function probeFinished(store: WorkerStore, incident: ToolIncident): boolean {
  try {
    return ['integrated', 'merged', 'cancelled'].includes(store.taskState(incident.probe.taskId) ?? '');
  } catch {
    return false;
  }
}

export function listOpenToolIncidents(store: WorkerStore): ToolIncident[] {
  return [...currentStates(store).values()]
    .filter((state) => state.status === 'open' && !probeFinished(store, state.incident))
    .map((state) => structuredClone(state.incident))
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

/** Invocation-local view used by status to share its incident history and probe task reads. */
export function projectToolIncidentStatus(store: WorkerStore, tasks: readonly Task[]) {
  const states = currentStates(store);
  const taskStates = new Map<string, string | undefined>(
    tasks.map((task): [string, string | undefined] => [task.id, task.state]),
  );
  for (const { status, incident } of states.values()) {
    if (status !== 'open' || taskStates.has(incident.probe.taskId)) continue;
    try {
      taskStates.set(incident.probe.taskId, store.taskState(incident.probe.taskId));
    } catch {
      taskStates.set(incident.probe.taskId, undefined);
    }
  }
  const active = new Map<string, ToolIncident>();
  for (const { status, incident } of states.values()) {
    if (
      status === 'open' &&
      !['integrated', 'merged', 'cancelled'].includes(taskStates.get(incident.probe.taskId) ?? '')
    )
      active.set(incident.fingerprint, incident);
  }
  return {
    toolIncidents: [...active.values()]
      .map((incident) => structuredClone(incident))
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
    forAttempt(task: Task, attempt: Attempt): ToolIncident | null {
      const fingerprint = incidentFingerprint(store, task, attempt);
      const incident = fingerprint ? active.get(fingerprint) : undefined;
      return incident ? structuredClone(incident) : null;
    },
  };
}

export type TransportFailure = {
  sequence: number;
  count: number;
  line: string;
  nextResumeAt: string;
  delayMs: number;
};

export function lastTransportFailure(
  store: WorkerStore,
  ref: Pick<AttemptRef, 'taskId' | 'attempt'>,
): TransportFailure | null {
  const event = store
    .events(ref.taskId, ref.attempt)
    .filter((candidate) => candidate.kind === TRANSPORT_FAILURE_EVENT)
    .at(-1);
  if (!event) return null;
  const body = parse<{ count?: unknown; line?: unknown; nextResumeAt?: unknown; delayMs?: unknown }>(event.body);
  if (!body || typeof body.line !== 'string' || typeof body.nextResumeAt !== 'string') return null;
  return {
    sequence: event.sequence,
    count: typeof body.count === 'number' ? body.count : 0,
    line: body.line,
    nextResumeAt: body.nextResumeAt,
    delayMs: typeof body.delayMs === 'number' ? body.delayMs : 0,
  };
}

function incidentFingerprint(store: WorkerStore, task: Task, attempt: Attempt): string {
  if (attempt.failureKind === 'tool') return blockerFingerprint(attempt, task.worktree, store.policy.worker);
  const transport = lastTransportFailure(store, attempt);
  return transport
    ? blockerFingerprint({ blocker: transport.line, result: '' }, task.worktree, store.policy.worker)
    : '';
}

function openIncidentForFingerprint(store: WorkerStore, fingerprint: string): ToolIncident | null {
  const state = currentStates(store).get(fingerprint);
  return state?.status === 'open' && !probeFinished(store, state.incident) ? structuredClone(state.incident) : null;
}

function blockerLine(attempt: Attempt): string {
  return (
    (attempt.blocker || attempt.result || '')
      .split(/\r?\n/, 1)[0]
      ?.replace(/\x1b\[[0-9;]*m/g, '')
      .trim() ?? ''
  );
}

function trackedSourceLocation(checkout: string, message: string, policy: typeof defaultPolicy.toolIncidents): string {
  try {
    const result = spawnSync('git', ['grep', '-n', '-F', '--', message], {
      cwd: checkout,
      encoding: 'utf8',
      maxBuffer: policy.sourceBufferBytes,
      timeout: policy.sourceTimeoutMs,
    });
    if (result.status === 0) return result.stdout.trim().split(/\r?\n/, 1)[0] ?? 'tracked match';
    if (result.status === 1) return 'no tracked source match';
    return `git grep failed: ${result.error?.message ?? 'unknown error'}`;
  } catch (error) {
    return `git grep failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function recentFailures(store: WorkerStore, fingerprint: string, since: string): StoredEvent[] {
  return store.db
    .query(
      `SELECT sequence,task_id,attempt,at,body FROM worker_events
        WHERE kind=? AND at>=? AND json_extract(body,'$.fingerprint')=? ORDER BY sequence`,
    )
    .all(FAILURE_EVENT, since, fingerprint) as StoredEvent[];
}

function exampleTasks(rows: readonly StoredEvent[], limit: number): Array<{ taskId: string; attempt: number }> {
  const seen = new Set<string>();
  const examples: Array<{ taskId: string; attempt: number }> = [];
  for (const row of rows) {
    if (seen.has(row.task_id)) continue;
    seen.add(row.task_id);
    examples.push({ taskId: row.task_id, attempt: row.attempt });
    if (examples.length === limit) break;
  }
  return examples;
}

function saveState(
  store: WorkerStore,
  ref: AttemptRef,
  status: IncidentState['status'],
  incident: ToolIncident,
  metadata: Partial<Pick<IncidentState, 'openingFailureSequence' | 'probeRunSequence' | 'resolution'>> = {},
): void {
  const current = currentStates(store).get(incident.fingerprint);
  insertEvent(store, ref, STATE_EVENT, new Date().toISOString(), {
    status,
    incident,
    ...(current?.status === 'open'
      ? {
          openingFailureSequence: current.openingFailureSequence,
          probeRunSequence: current.probeRunSequence,
        }
      : {}),
    ...metadata,
  });
}

function latestWorkerRun(store: WorkerStore, ref: AttemptRef): StoredEvent | null {
  return (
    (store.db
      .query(
        `SELECT sequence,task_id,attempt,at,body FROM worker_events
          WHERE task_id=? AND attempt=? AND kind='worker-run-started' ORDER BY sequence DESC LIMIT 1`,
      )
      .get(ref.taskId, ref.attempt) as StoredEvent | undefined) ?? null
  );
}

function latestFailureForTask(store: WorkerStore, taskId: string, fingerprint: string): StoredEvent | null {
  return (
    (store.db
      .query(
        `SELECT sequence,task_id,attempt,at,body FROM worker_events
          WHERE kind=? AND task_id=? AND json_extract(body,'$.fingerprint')=? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(FAILURE_EVENT, taskId, fingerprint) as StoredEvent | undefined) ?? null
  );
}

function runLogStartOffset(run: StoredEvent): number | null {
  const body = parse<{ logStartOffset?: unknown }>(run.body);
  return typeof body?.logStartOffset === 'number' && Number.isSafeInteger(body.logStartOffset) && body.logStartOffset >= 0
    ? body.logStartOffset
    : null;
}

function hasProviderProgress(store: WorkerStore, attempt: Attempt, logStartOffset: number): boolean {
  const adapter = agentAdapter(attempt.profile.cli);
  return readLogFromOffset(attempt.logPath, logStartOffset, store.policy.worker.logTailBytes)
    .split(/\r?\n/)
    .some((line) => {
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const event = value as Record<string, unknown>;
        return adapter.matchesEvent(event) && adapter.failure(event) === null;
      } catch {
        return false;
      }
    });
}

function releaseIncidentRetries(store: WorkerStore, incident: ToolIncident): void {
  for (const intent of store.retryIntents()) {
    if (intent.status !== 'pending' || !incident.taskIds.includes(intent.taskId)) continue;
    delete intent.options.notBefore;
    store.db
      .query('UPDATE worker_retry_intents SET body=? WHERE task_id=? AND attempt=?')
      .run(JSON.stringify(intent), intent.taskId, intent.attempt);
  }
}

function resolvedIncident(
  store: WorkerStore,
  ref: AttemptRef,
  incident: ToolIncident,
  evidence: IncidentResolutionEvidence,
): ToolIncident {
  const resolved = { ...incident, probe: ref };
  saveState(store, ref, 'resolved', resolved, { resolution: { probe: ref, evidence } });
  releaseIncidentRetries(store, incident);
  return resolved;
}

function ensurePendingRetry(store: WorkerStore, ref: AttemptRef, options: RetryIntent['options'] = {}): void {
  const existing = store.retryIntent(ref);
  if (!existing) {
    store.saveRetryIntent(ref, options);
    return;
  }
  if (existing.status === 'pending') return;
  if (store.task(ref.taskId).currentAttempt !== ref.attempt) return;
  store.updateRetryIntent(ref, (intent) => {
    intent.status = 'pending';
    intent.options = { ...intent.options, ...options };
    delete intent.nextAttempt;
  });
}

function ensureIncidentRetries(store: WorkerStore, incident: ToolIncident, since: string): void {
  const latest = new Map<string, AttemptRef>();
  for (const row of recentFailures(store, incident.fingerprint, since))
    latest.set(row.task_id, { taskId: row.task_id, attempt: row.attempt });
  for (const ref of latest.values())
    if (store.task(ref.taskId).currentAttempt === ref.attempt) ensurePendingRetry(store, ref);
}

function deliverIncident(
  store: WorkerStore,
  inbox: ManagerInbox,
  settings: Settings,
  incident: ToolIncident,
): ToolIncident | null {
  return store.db
    .transaction(() => {
      const current = openIncidentForFingerprint(store, incident.fingerprint);
      if (!current || current.noticeDelivered) return current;
      const examples = current.exampleTasks.map((example) => `${example.taskId}#${example.attempt}`).join(', ');
      const event: ManagerEvent = {
        managerId: settings.integration.supermanager,
        kind: 'blocker',
        summary: [
          `Environment incident ${current.id}: ${current.errorLine ?? current.line}`,
          `${current.taskIds.length} distinct tasks ended with this blocker within ${(settings.policy ?? defaultPolicy).toolIncidents.windowMs / 60_000} minutes.`,
          `Example tasks: ${examples}.`,
          `Source location (git grep): ${current.sourceLocation}.`,
          `Retries are held while one affected task is retried every ${(settings.policy ?? defaultPolicy).toolIncidents.probeMs / 60_000} minutes.`,
        ].join(' '),
      };
      inbox.deliver(event);
      const delivered = { ...current, noticeDelivered: true };
      saveState(store, current.probe, 'open', delivered);
      return delivered;
    })
    .immediate();
}

/** Record a tool failure and open or update the shared incident when its threshold is reached. */
export function recordToolBlockerFailure(
  store: WorkerStore,
  task: Task,
  attempt: Attempt,
  settings: Settings,
  inbox: ManagerInbox,
  now = Date.now(),
  options: { queueRetries?: boolean } = {},
): { incident: ToolIncident | null; opened: boolean } {
  const policy = (settings.policy ?? defaultPolicy).toolIncidents;
  const ref = { taskId: task.id, attempt: attempt.attempt };
  const rawLine = blockerLine(attempt);
  const fingerprint = blockerFingerprint(attempt, task.worktree, store.policy.worker);
  if (!fingerprint) return { incident: null, opened: false };
  const line = fingerprint;
  const at = new Date(now).toISOString();
  const openedAt = new Date(now - policy.windowMs).toISOString();
  const existingFailure = store.db
    .query('SELECT 1 FROM worker_events WHERE task_id=? AND attempt=? AND kind=? LIMIT 1')
    .get(ref.taskId, ref.attempt, FAILURE_EVENT);

  if (!existingFailure) insertEvent(store, ref, FAILURE_EVENT, at, { fingerprint, line, rawLine });

  let opened = false;
  let incident = store.db
    .transaction(() => {
      const current = openIncidentForFingerprint(store, fingerprint);
      if (current) {
        const taskIds = [...new Set([...current.taskIds, task.id])];
        const examples = [...current.exampleTasks];
        if (!examples.some((example) => example.taskId === task.id))
          examples.push({ taskId: task.id, attempt: attempt.attempt });
        const probingFailure =
          current.probe.taskId === ref.taskId &&
          (ref.attempt === current.probe.attempt || ref.attempt === current.probe.attempt + 1);
        const updated: ToolIncident = {
          ...current,
          updatedAt: at,
          taskIds,
          exampleTasks: examples.slice(0, policy.exampleTasks),
          ...(probingFailure ? { probe: ref, nextProbeAt: new Date(now + policy.probeMs).toISOString() } : {}),
        };
        const run = probingFailure ? latestWorkerRun(store, ref) : null;
        saveState(store, ref, 'open', updated, run ? { probeRunSequence: run.sequence } : {});
        return updated;
      }

      const rows = recentFailures(store, fingerprint, openedAt);
      const ids = [...new Set(rows.map((row) => row.task_id))];
      if (ids.length < policy.threshold) return null;

      const created: ToolIncident = {
        id: crypto.randomUUID(),
        fingerprint,
        line,
        errorLine: rawLine || fingerprint,
        sourceLocation: trackedSourceLocation(settings.mainCheckout, rawLine, policy),
        openedAt: at,
        updatedAt: at,
        nextProbeAt: new Date(now + policy.probeMs).toISOString(),
        probe: ref,
        taskIds: ids,
        exampleTasks: exampleTasks(rows, policy.exampleTasks),
        noticeDelivered: false,
      };
      opened = true;
      const openingFailure = rows.at(-1);
      const run = latestWorkerRun(store, ref);
      saveState(store, ref, 'open', created, {
        ...(openingFailure ? { openingFailureSequence: openingFailure.sequence } : {}),
        ...(run ? { probeRunSequence: run.sequence } : {}),
      });
      return created;
    })
    .immediate();

  if (incident) {
    if (options.queueRetries !== false)
      ensureIncidentRetries(store, incident, new Date(Date.parse(incident.openedAt) - policy.windowMs).toISOString());
    if (!incident.noticeDelivered) {
      try {
        incident = deliverIncident(store, inbox, settings, incident) ?? incident;
      } catch (error) {
        console.error('tool incident inbox delivery failed:', error);
      }
    }
  }
  return { incident, opened };
}

/**
 * Record a provider transport drop against the shared environment incident whose fingerprint is the transport line.
 * Held peers stay on their current attempt; only the probe resumes until it gets past the drop.
 */
export function recordTransportFailure(
  store: WorkerStore,
  task: Task,
  attempt: Attempt,
  settings: Settings,
  inbox: ManagerInbox,
  line: string,
  now = Date.now(),
): { incident: ToolIncident | null; opened: boolean } {
  const viewed: Attempt = { ...attempt, failureKind: 'tool', blocker: line, result: line };
  const result = recordToolBlockerFailure(store, task, viewed, settings, inbox, now, { queueRetries: false });
  const nextResumeAt = lastTransportFailure(store, { taskId: task.id, attempt: attempt.attempt })?.nextResumeAt;
  if (result.incident && nextResumeAt && result.incident.probe.taskId === task.id) {
    const updated = { ...result.incident, nextProbeAt: nextResumeAt };
    saveState(store, { taskId: task.id, attempt: attempt.attempt }, 'open', updated);
    return { incident: updated, opened: result.opened };
  }
  return result;
}

/** Retry saved notices during the host's existing recovery sweep without changing incident or probe state. */
export function recoverUndeliveredToolIncidentNotices(
  store: WorkerStore,
  inbox: ManagerInbox,
  settings: Settings,
): void {
  for (const incident of listOpenToolIncidents(store)) {
    if (incident.noticeDelivered) continue;
    try {
      deliverIncident(store, inbox, settings, incident);
    } catch (error) {
      console.error('tool incident inbox delivery failed:', error);
    }
  }
}

/** The retry intent is keyed by the failed attempt, so this is the incident that owns its next launch. */
export function toolIncidentForRetry(store: WorkerStore, ref: AttemptRef): ToolIncident | null {
  try {
    const task = store.task(ref.taskId);
    const attempt = store.attempt(ref);
    const fingerprint = incidentFingerprint(store, task, attempt);
    return fingerprint ? openIncidentForFingerprint(store, fingerprint) : null;
  } catch {
    return null;
  }
}

/** Waiting transport resumes only the incident probe, after its own backoff. */
export function transportIncidentResumeAllowed(store: WorkerStore, ref: AttemptRef, now = Date.now()): boolean {
  const transport = lastTransportFailure(store, ref);
  if (!transport) return true;
  try {
    const task = store.task(ref.taskId);
    const fingerprint = blockerFingerprint({ blocker: transport.line, result: '' }, task.worktree, store.policy.worker);
    const incident = fingerprint ? openIncidentForFingerprint(store, fingerprint) : null;
    if (!incident) return true;
    return incident.probe.taskId === ref.taskId;
  } catch {
    return true;
  }
}

export function toolIncidentRetryAllowed(store: WorkerStore, ref: AttemptRef, now = Date.now()): boolean {
  const incident = toolIncidentForRetry(store, ref);
  if (!incident) return true;
  return (
    incident.probe.taskId === ref.taskId &&
    incident.probe.attempt === ref.attempt &&
    Date.parse(incident.nextProbeAt) <= now
  );
}

/** Persist a manual retry request without starting the worker while its shared incident is open. */
export function holdRetryForToolIncident(
  store: WorkerStore,
  ref: AttemptRef,
  options: RetryIntent['options'],
): boolean {
  if (toolIncidentRetryAllowed(store, ref)) return false;
  ensurePendingRetry(store, ref, options);
  return true;
}

/** Promote a post-failure launch from an affected task to the probe for its incident. */
export function noteToolIncidentProbeStarted(store: WorkerStore, ref: AttemptRef): ToolIncident[] {
  const run = latestWorkerRun(store, ref);
  if (!run) return [];

  return store.db
    .transaction(() => {
      const promoted: ToolIncident[] = [];
      for (const state of currentStates(store).values()) {
        const { incident } = state;
        if (state.status !== 'open' || !incident.taskIds.includes(ref.taskId)) continue;
        const previousFailure = latestFailureForTask(store, ref.taskId, incident.fingerprint);
        const openingSequence = state.openingFailureSequence ?? 0;
        const previousProbeSequence = state.probeRunSequence ?? 0;
        const failureSequence = previousFailure?.sequence ?? 0;
        const boundary = Math.max(openingSequence, previousProbeSequence, failureSequence);
        if (run.sequence <= boundary || (previousFailure && previousFailure.attempt > ref.attempt)) continue;
        if (
          state.openingFailureSequence === undefined &&
          (!Number.isFinite(Date.parse(run.at)) || Date.parse(run.at) <= Date.parse(incident.openedAt))
        )
          continue;

        const next = { ...incident, probe: ref };
        saveState(store, ref, 'open', next, { probeRunSequence: run.sequence });
        promoted.push(next);
      }
      return promoted;
    })
    .immediate();
}

/** Resolve when the current probe has appended provider output after its post-failure run boundary. */
export function resolveToolIncidentsAfterProviderProgress(
  store: WorkerStore,
  ref: AttemptRef,
  task: Task,
  attempt: Attempt,
): ToolIncident[] {
  const run = latestWorkerRun(store, ref);
  if (!run) return [];
  const logStartOffset = runLogStartOffset(run);
  if (logStartOffset === null) return [];
  const observedLogSize = statSync(attempt.logPath, { throwIfNoEntry: false })?.size ?? 0;
  if (observedLogSize <= logStartOffset || !hasProviderProgress(store, attempt, logStartOffset)) return [];

  const attemptFingerprint =
    attempt.failureKind === 'tool' ? blockerFingerprint(attempt, task.worktree, store.policy.worker) : null;
  const transport = lastTransportFailure(store, ref);
  const transportFingerprint = transport
    ? blockerFingerprint({ blocker: transport.line, result: '' }, task.worktree, store.policy.worker)
    : null;

  return store.db
    .transaction(() => {
      const resolved: ToolIncident[] = [];
      for (const state of currentStates(store).values()) {
        const { incident } = state;
        if (
          state.status !== 'open' ||
          incident.probe.taskId !== ref.taskId ||
          incident.probe.attempt !== ref.attempt ||
          state.probeRunSequence !== run.sequence ||
          attemptFingerprint === incident.fingerprint
        )
          continue;

        const previousFailure = latestFailureForTask(store, ref.taskId, incident.fingerprint);
        if (previousFailure && previousFailure.sequence >= run.sequence) continue;
        if (
          transportFingerprint === incident.fingerprint &&
          transport !== null &&
          transport.sequence > run.sequence
        )
          continue;

        const failureSequence = Math.max(
          state.openingFailureSequence ?? 0,
          previousFailure?.sequence ?? 0,
          transportFingerprint === incident.fingerprint && transport && transport.sequence < run.sequence
            ? transport.sequence
            : 0,
        );
        if (!failureSequence || failureSequence >= run.sequence) continue;
        resolved.push(
          resolvedIncident(store, ref, incident, {
            kind: 'provider-log-progress',
            probe: ref,
            failureSequence,
            workerRunSequence: run.sequence,
            logStartOffset,
            observedLogSize,
          }),
        );
      }
      return resolved;
    })
    .immediate();
}

/** Close incidents whose probe attempt no longer reports the same tool blocker and release held retries. */
export function resolveToolIncidentsAfterAttempt(
  store: WorkerStore,
  ref: AttemptRef,
  task: Task,
  attempt: Attempt,
): ToolIncident[] {
  const fingerprint =
    attempt.failureKind === 'tool' ? blockerFingerprint(attempt, task.worktree, store.policy.worker) : null;
  return store.db
    .transaction(() => {
      const resolved: ToolIncident[] = [];
      for (const state of currentStates(store).values()) {
        const { incident } = state;
        if (
          state.status !== 'open' ||
          incident.probe.taskId !== ref.taskId ||
          ref.attempt < incident.probe.attempt ||
          fingerprint === incident.fingerprint
        )
          continue;

        resolvedIncident(store, ref, incident, {
          kind: 'attempt-ended',
          probe: ref,
          state: attempt.state,
          failureKind: attempt.failureKind,
          fingerprint,
        });
        resolved.push(incident);
      }
      return resolved;
    })
    .immediate();
}
