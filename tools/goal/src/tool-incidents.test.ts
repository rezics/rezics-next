import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt } from './types.ts';
import type { ManagerInbox } from './contracts.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';
import { listOpenToolIncidents, recordToolBlockerFailure, TOOL_INCIDENT_PROBE_MS } from './tool-incidents.ts';

test('a failed notice is recovered through the SQLite inbox without reopening the incident or probe', async () => {
  const h = harness(), now = Date.now(), errorLine = 'ENOSPC: shared cache read failed';
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
      h.store.nextAttempt(ref, (attempt) => ({
        taskId: task.id, attempt, state: 'exited', failureKind: 'tool', blocker: errorLine, result: errorLine,
      }) as unknown as Attempt);
      return { taskId: task.id, attempt: 1 };
    });
    const observe = (ref: (typeof refs)[number]) =>
      recordToolBlockerFailure(h.store, h.store.task(ref.taskId), h.store.attempt(ref), h.settings, flakyInbox, now);

    expect(refs.map((ref) => observe(ref).opened)).toEqual([false, false, true]);
    expect(inbox.read(h.settings.integration.supermanager)).toEqual([]);
    const incident = listOpenToolIncidents(h.store)[0]!;
    expect(incident).toMatchObject({
      line: errorLine.toLowerCase(), errorLine, probe: refs[2],
      nextProbeAt: new Date(now + TOOL_INCIDENT_PROBE_MS).toISOString(), noticeDelivered: false,
    });
    expect(refs.map((ref) => h.store.retryIntent(ref)?.status)).toEqual(['pending', 'pending', 'pending']);

    await new WorkerJob(h.tasks, { enqueue() {} }, flakyInbox).recoverOrphans({ adoptRunning: false });
    expect(listOpenToolIncidents(h.store)).toHaveLength(1);
    expect(tasks.map((task) => h.store.task(task.id).currentAttempt)).toEqual([1, 1, 1]);
    expect(listOpenToolIncidents(h.store)[0]).toMatchObject({
      id: incident.id, probe: incident.probe, nextProbeAt: incident.nextProbeAt, noticeDelivered: true,
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
