import { expect, test } from 'bun:test';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Attempt } from './types.ts';
import type { ManagerInbox } from './contracts.ts';
import { blockerFingerprint } from './attempt-progress.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';
import {
  listOpenToolIncidents,
  noteToolIncidentProbeStarted,
  projectToolIncidentStatus,
  recordTransportFailure,
  recordToolBlockerFailure,
  resolveToolIncidentsAfterAttempt,
  resolveToolIncidentsAfterProviderProgress,
  toolIncidentRetryAllowed,
  TOOL_INCIDENT_PROBE_MS,
} from './tool-incidents.ts';
import { TRANSPORT_FAILURE_EVENT } from './agents/shared.ts';

function incidentAttempt(taskId: string, attempt: number, blocker: string | null): Attempt {
  const now = new Date().toISOString();
  return {
    taskId,
    attempt,
    state: 'exited',
    failureKind: blocker ? 'tool' : null,
    profile: { cli: 'codex', model: 'fixture', effort: 'medium', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: now,
    endedAt: now,
    process: null,
    driver: null,
    logPath: '',
    evidencePath: '',
    auxiliaryProcesses: [],
    session: null,
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: blocker ? 1 : 0,
    result: blocker ?? 'RESULT: success',
    blocker,
    approaches: [],
  };
}

function seedIncident(h: ReturnType<typeof harness>, now: number, errorLine: string) {
  const tasks = Array.from({ length: 3 }, () => h.tasks.dispatch(h.briefFile));
  const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
  const refs = tasks.map((task) => {
    const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number) =>
      incidentAttempt(task.id, number, errorLine),
    );
    const ref = { taskId: task.id, attempt: attempt.attempt };
    const logPath = join(h.root, '.temp', 'goal', 'runs', task.id, `${attempt.attempt}.jsonl`);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, '{"type":"item.started"}\n');
    h.store.updateAttempt(ref, (current) => {
      current.logPath = logPath;
    });
    h.store.event(ref, 'worker-run-started', { logStartOffset: 0, resuming: false });
    return ref;
  });
  for (const ref of refs)
    recordToolBlockerFailure(h.store, h.store.task(ref.taskId), h.store.attempt(ref), h.settings, inbox, now);
  return { refs, inbox, incident: listOpenToolIncidents(h.store)[0]! };
}

test('an empty worker-ended prefix is not fingerprinted and does not open an incident', () => {
  const empty = 'Worker ended without a success report (exit 1): ';
  expect(blockerFingerprint({ blocker: empty, result: empty })).toBe('');
  expect(blockerFingerprint({ blocker: null, result: 'Worker ended without a success report (killed):' })).toBe('');
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number) =>
      incidentAttempt(task.id, number, empty),
    );
    expect(
      recordToolBlockerFailure(
        h.store,
        h.store.task(task.id),
        attempt,
        h.settings,
        new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory),
      ),
    ).toEqual({ incident: null, opened: false });
    expect(listOpenToolIncidents(h.store)).toEqual([]);
  } finally {
    h.dispose();
  }
}, 15_000);

test('a failed notice is recovered through the SQLite inbox without reopening the incident or probe', async () => {
  const h = harness(),
    now = Date.now(),
    errorLine = 'ENOSPC: shared cache read failed';
  try {
    const tasks = Array.from({ length: 3 }, () => h.tasks.dispatch(h.briefFile));
    writeFileSync(join(h.root, 'README.md'), `${errorLine}\n`);
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    let failFirstDelivery = true;
    const flakyInbox: ManagerInbox = {
      deliver: (event) => {
        if (failFirstDelivery) {
          failFirstDelivery = false;
          throw new Error('temporary inbox refusal');
        }
        inbox.deliver(event);
      },
    };
    const refs = tasks.map((task) => {
      const ref = { taskId: task.id, attempt: 0 };
      h.store.nextAttempt(
        ref,
        (attempt) =>
          ({
            taskId: task.id,
            attempt,
            state: 'exited',
            failureKind: 'tool',
            blocker: errorLine,
            result: errorLine,
          }) as unknown as Attempt,
      );
      return { taskId: task.id, attempt: 1 };
    });
    const observe = (ref: (typeof refs)[number]) =>
      recordToolBlockerFailure(h.store, h.store.task(ref.taskId), h.store.attempt(ref), h.settings, flakyInbox, now);

    expect(refs.map((ref) => observe(ref).opened)).toEqual([false, false, true]);
    expect(inbox.read(h.settings.integration.supermanager)).toEqual([]);
    const incident = listOpenToolIncidents(h.store)[0]!;
    expect(incident).toMatchObject({
      line: errorLine.toLowerCase(),
      errorLine,
      probe: refs[2],
      nextProbeAt: new Date(now + TOOL_INCIDENT_PROBE_MS).toISOString(),
      noticeDelivered: false,
    });
    expect(refs.map((ref) => h.store.retryIntent(ref)?.status)).toEqual(['pending', 'pending', 'pending']);

    await new WorkerJob(h.tasks, { enqueue() {} }, flakyInbox).recoverOrphans({ adoptRunning: false });
    expect(listOpenToolIncidents(h.store)).toHaveLength(1);
    expect(tasks.map((task) => h.store.task(task.id).currentAttempt)).toEqual([1, 1, 1]);
    expect(listOpenToolIncidents(h.store)[0]).toMatchObject({
      id: incident.id,
      probe: incident.probe,
      nextProbeAt: incident.nextProbeAt,
      noticeDelivered: true,
    });
    const messages = inbox.read(h.settings.integration.supermanager);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.event).toMatchObject({ managerId: h.settings.integration.supermanager, kind: 'blocker' });
    expect(messages[0]?.event.summary).toContain(`${incident.id}: ${errorLine}`);
    expect(messages[0]?.event.summary).toContain(`Example tasks: ${tasks[0]!.id}#1`);
    expect(messages[0]?.event.summary).toContain(`Source location (git grep): README.md:1:${errorLine}`);
  } finally {
    h.dispose();
  }
});

test('provider output after a post-failure run resolves the incident before its attempt ends', () => {
  const h = harness(),
    now = Date.now(),
    errorLine = 'ENOSPC: shared cache read failed';
  try {
    const { refs, incident } = seedIncident(h, now, errorLine);
    const probeRef = incident.probe;
    const probeTask = h.store.task(probeRef.taskId);
    const logPath = h.store.attempt(probeRef).logPath;
    const initialSize = statSync(logPath).size;
    const laterNotBefore = new Date(now + 60 * 60_000).toISOString();
    const heldRefs = refs.filter((ref) => ref.taskId !== probeRef.taskId);
    for (const ref of refs)
      h.store.updateRetryIntent(ref, (intent) => {
        intent.options.notBefore = laterNotBefore;
      });

    h.store.updateAttempt(probeRef, (attempt) => {
      attempt.state = 'running';
      attempt.failureKind = null;
      attempt.blocker = null;
      attempt.result = '';
    });
    noteToolIncidentProbeStarted(h.store, probeRef);
    expect(
      resolveToolIncidentsAfterProviderProgress(
        h.store,
        probeRef,
        probeTask,
        h.store.attempt(probeRef),
      ),
    ).toEqual([]);
    expect(listOpenToolIncidents(h.store)).toEqual([incident]);

    h.store.event(probeRef, 'worker-run-started', { logStartOffset: initialSize, resuming: true });
    noteToolIncidentProbeStarted(h.store, probeRef);
    expect(
      resolveToolIncidentsAfterProviderProgress(
        h.store,
        probeRef,
        probeTask,
        h.store.attempt(probeRef),
      ),
    ).toEqual([]);
    expect(listOpenToolIncidents(h.store)[0]?.probe).toEqual(probeRef);

    const output = '{"type":"thread.started","thread_id":"recovered-session"}\n';
    writeFileSync(logPath, output, { flag: 'a' });
    expect(
      resolveToolIncidentsAfterProviderProgress(
        h.store,
        probeRef,
        probeTask,
        h.store.attempt(probeRef),
      ),
    ).toEqual([{ ...incident, probe: probeRef }]);
    expect(listOpenToolIncidents(h.store)).toEqual([]);
    expect(heldRefs.map((ref) => toolIncidentRetryAllowed(h.store, ref, now))).toEqual([true, true]);
    expect(heldRefs.map((ref) => h.store.retryIntent(ref)?.options.notBefore)).toEqual([undefined, undefined]);

    const resolutions = h.store
      .events(probeRef.taskId, probeRef.attempt)
      .filter((event) => event.kind === 'tool-blocker-incident-state')
      .map((event) => JSON.parse(event.body) as { status?: string; resolution?: Record<string, unknown> })
      .filter((event) => event.status === 'resolved');
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.resolution).toMatchObject({
      probe: probeRef,
      evidence: {
        kind: 'provider-log-progress',
        probe: probeRef,
        workerRunSequence: h.store
          .events(probeRef.taskId, probeRef.attempt)
          .findLast((event) => event.kind === 'worker-run-started')?.sequence,
        logStartOffset: initialSize,
        observedLogSize: initialSize + Buffer.byteLength(output),
      },
    });
  } finally {
    h.dispose();
  }
});

test('a probe that repeats its transport fingerprint stays open and advances its next probe time', () => {
  const h = harness(),
    now = Date.now(),
    errorLine = 'stream disconnected';
  try {
    const { incident, inbox } = seedIncident(h, now, errorLine);
    const retry = h.store.nextAttempt(incident.probe, (attempt) =>
      incidentAttempt(incident.probe.taskId, attempt, errorLine),
    );
    const ref = { taskId: retry.taskId, attempt: retry.attempt };
    const nextResumeAt = new Date(now + 75_000).toISOString();
    h.store.event(ref, 'worker-run-started', { logStartOffset: 0, resuming: true });
    noteToolIncidentProbeStarted(h.store, ref);
    h.store.event(ref, TRANSPORT_FAILURE_EVENT, {
      count: 2,
      line: errorLine,
      delayMs: 60_000,
      nextResumeAt,
    });

    const result = recordTransportFailure(
      h.store,
      h.store.task(ref.taskId),
      h.store.attempt(ref),
      h.settings,
      inbox,
      errorLine,
      now + 1_000,
    );

    expect(result.opened).toBe(false);
    expect(listOpenToolIncidents(h.store)).toEqual([
      { ...incident, probe: ref, updatedAt: new Date(now + 1_000).toISOString(), nextProbeAt: nextResumeAt },
    ]);
    expect(
      h.store
        .events(ref.taskId, ref.attempt)
        .filter((event) => event.kind === 'tool-blocker-incident-state')
        .map((event) => JSON.parse(event.body) as { status?: string })
        .filter((event) => event.status === 'resolved'),
    ).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test('later and integrated probes release held retries without another probe', () => {
  const h = harness(),
    now = Date.now(),
    errorLine = 'ENOSPC: shared cache read failed';
  try {
    const { refs, inbox, incident } = seedIncident(h, now, errorLine);
    const heldRefs = refs.filter((ref) => ref.taskId !== incident.probe.taskId);
    const projection = projectToolIncidentStatus(h.store, h.store.tasks());
    expect(projection.toolIncidents).toEqual([incident]);
    const byAttempt = projection.forAttempt(h.store.task(heldRefs[0]!.taskId), h.store.attempt(heldRefs[0]!))!;
    expect(byAttempt).toEqual(incident);
    byAttempt.taskIds.push('changed-copy');
    expect(projection.toolIncidents[0]!.taskIds).not.toContain('changed-copy');
    const laterNotBefore = new Date(now + 60 * 60_000).toISOString();
    for (const ref of refs)
      h.store.updateRetryIntent(ref, (intent) => {
        intent.options.notBefore = laterNotBefore;
      });

    expect(heldRefs.map((ref) => toolIncidentRetryAllowed(h.store, ref, now + TOOL_INCIDENT_PROBE_MS))).toEqual([
      false,
      false,
    ]);
    const differentLine = 'ECONNRESET: worker transport closed';
    const laterAttempt = h.store.nextAttempt(incident.probe, (attempt) =>
      incidentAttempt(incident.probe.taskId, attempt, differentLine),
    );
    const laterRef = { taskId: incident.probe.taskId, attempt: laterAttempt.attempt };
    const task = h.store.task(laterRef.taskId);

    expect(resolveToolIncidentsAfterAttempt(h.store, laterRef, task, laterAttempt)).toEqual([incident]);
    const resolvedProjection = projectToolIncidentStatus(h.store, h.store.tasks());
    expect(resolvedProjection.toolIncidents).toEqual([]);
    expect(resolvedProjection.forAttempt(h.store.task(heldRefs[0]!.taskId), h.store.attempt(heldRefs[0]!))).toBeNull();
    expect(recordToolBlockerFailure(h.store, task, laterAttempt, h.settings, inbox, now + 1)).toEqual({
      incident: null,
      opened: false,
    });
    expect(listOpenToolIncidents(h.store)).toEqual([]);
    expect(heldRefs.map((ref) => toolIncidentRetryAllowed(h.store, ref, now))).toEqual([true, true]);
    for (const ref of heldRefs) {
      expect(h.store.retryIntent(ref)?.status).toBe('pending');
      expect(h.store.retryIntent(ref)?.options.notBefore).toBeUndefined();
    }
    expect(h.store.attempts(incident.probe.taskId)).toHaveLength(2);

    const laterRefs = refs.map((ref) => {
      if (ref.taskId === incident.probe.taskId) return laterRef;
      const attempt = h.store.nextAttempt(ref, (number) => incidentAttempt(ref.taskId, number, differentLine));
      const nextRef = { taskId: ref.taskId, attempt: attempt.attempt };
      recordToolBlockerFailure(h.store, h.store.task(ref.taskId), attempt, h.settings, inbox, now + 2);
      return nextRef;
    });
    expect(listOpenToolIncidents(h.store)).toHaveLength(1);
    const nextIncident = listOpenToolIncidents(h.store)[0]!;
    expect(nextIncident.id).not.toBe(incident.id);
    const nextHeldRefs = laterRefs.filter((ref) => ref.taskId !== nextIncident.probe.taskId);
    expect(nextHeldRefs.map((ref) => toolIncidentRetryAllowed(h.store, ref, now))).toEqual([false, false]);

    const integratedAttempt = h.store.nextAttempt(nextIncident.probe, (attempt) =>
      incidentAttempt(nextIncident.probe.taskId, attempt, null),
    );
    h.store.updateTask({ taskId: nextIncident.probe.taskId, attempt: integratedAttempt.attempt }, (task) => {
      task.state = 'integrated';
      task.integratedBase = task.base;
      task.integratedCommit = task.base;
      task.integratedCommits = [task.base];
    });

    expect(listOpenToolIncidents(h.store)).toEqual([]);
    const finishedProjection = projectToolIncidentStatus(h.store, h.store.tasks());
    expect(finishedProjection.toolIncidents).toEqual([]);
    expect(
      finishedProjection.forAttempt(h.store.task(nextHeldRefs[0]!.taskId), h.store.attempt(nextHeldRefs[0]!)),
    ).toBeNull();
    expect(nextHeldRefs.map((ref) => toolIncidentRetryAllowed(h.store, ref, now))).toEqual([true, true]);
    expect(nextHeldRefs.map((ref) => h.store.retryIntent(ref)?.status)).toEqual(['pending', 'pending']);
    expect(h.store.attempts(nextIncident.probe.taskId)).toHaveLength(3);
  } finally {
    h.dispose();
  }
});
