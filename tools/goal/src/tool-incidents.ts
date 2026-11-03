import { defaultPolicy } from './policy.ts';
import { spawnSync } from 'node:child_process';
import type { AttemptRef, ManagerInbox, ManagerEvent } from './contracts.ts';
import { blockerFingerprint } from './attempt-progress.ts';
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

type IncidentState = { status: 'open' | 'resolved'; incident: ToolIncident };

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

function saveState(store: WorkerStore, ref: AttemptRef, status: IncidentState['status'], incident: ToolIncident): void {
  insertEvent(store, ref, STATE_EVENT, new Date().toISOString(), { status, incident });
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
        const probingFailure = current.probe.taskId === ref.taskId && ref.attempt === current.probe.attempt + 1;
        const updated: ToolIncident = {
          ...current,
          updatedAt: at,
          taskIds,
          exampleTasks: examples.slice(0, policy.exampleTasks),
          ...(probingFailure ? { probe: ref, nextProbeAt: new Date(now + policy.probeMs).toISOString() } : {}),
        };
        saveState(store, ref, 'open', updated);
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
      saveState(store, ref, 'open', created);
      return created;
    })
    .immediate();

  if (incident) {
    ensureIncidentRetries(
      store,
      incident,
      new Date(Date.parse(incident.openedAt) - policy.windowMs).toISOString(),
    );
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
    if (attempt.failureKind !== 'tool') return null;
    return openIncidentForFingerprint(store, blockerFingerprint(attempt, task.worktree, store.policy.worker));
  } catch {
    return null;
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

/** Close incidents whose probe attempt no longer reports the same tool blocker and release held retries. */
export function resolveToolIncidentsAfterAttempt(
  store: WorkerStore,
  ref: AttemptRef,
  task: Task,
  attempt: Attempt,
): ToolIncident[] {
  const fingerprint = attempt.failureKind === 'tool' ? blockerFingerprint(attempt, task.worktree, store.policy.worker) : null;
  const resolved: ToolIncident[] = [];
  for (const incident of listOpenToolIncidents(store)) {
    if (
      incident.probe.taskId !== ref.taskId ||
      ref.attempt <= incident.probe.attempt ||
      fingerprint === incident.fingerprint
    )
      continue;
    saveState(store, ref, 'resolved', incident);
    for (const intent of store.retryIntents()) {
      if (intent.status !== 'pending' || !incident.taskIds.includes(intent.taskId)) continue;
      store.updateRetryIntent(intent, (current) => {
        delete current.options.notBefore;
      });
    }
    resolved.push(incident);
  }
  return resolved;
}
