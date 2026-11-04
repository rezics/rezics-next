import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationOverlap } from './continuation.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';
import { retryWait } from './watchdog.ts';

for (const [operation, terminal] of [
  ['stop', 'stopped'],
  ['cancel', 'cancelled'],
] as const) {
  test(`the host settles an unknown ${operation} after run PIDs and the worktree are clear`, async () => {
    const h = harness('#!/usr/bin/env bun\n');
    try {
      const task = h.tasks.dispatch(h.briefFile),
        worker = await h.tasks.retry(task.id),
        ref = worker.attempt;
      await worker.exited;
      h.store.updateAttempt(ref, (attempt) => {
        attempt.process = null;
      });
      await expect(operation === 'cancel' ? h.tasks.cancel(task.id) : h.tasks.stop(task.id)).rejects.toThrow(
        'unknown process identity',
      );

      await new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} }).recoverOrphans({ adoptRunning: false });

      expect(h.store.task(task.id).state).toBe(terminal);
      expect(h.store.attempt(ref)).toMatchObject({
        state: terminal,
        terminationIntent: { operation, state: 'complete', processIdentity: 'unknown', process: null },
      });
    } finally {
      await h.disposeAsync();
    }
  });
}

for (const terminal of ['stopped', 'cancelled'] as const) {
  test(`a held task is released and its owner is told when its ${terminal} predecessor is dropped`, async () => {
    const h = harness('#!/usr/bin/env bun\n');
    try {
      const predecessor = h.tasks.dispatch(h.briefFile),
        heldPath = join(h.settings.stateDirectory, 'held.md');
      writeFileSync(
        heldPath,
        markdown.replace('paths: [result.txt]', `paths: [dependent.txt]\nafter: [${predecessor.id}]`),
      );
      const held = h.tasks.dispatch(heldPath);
      expect(held.state).toBe('held');
      h.store.updateTask({ taskId: predecessor.id, attempt: 0 }, (task) => {
        task.state = terminal;
      });
      const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);

      await new WorkerJob(h.tasks, { enqueue() {} }, inbox).recoverOrphans();

      expect(h.store.task(held.id).state).not.toBe('held');
      expect(
        inbox
          .read(held.brief.manager)
          .map((entry) => entry.event.summary)
          .join('\n'),
      ).toContain(predecessor.id);
    } finally {
      await h.disposeAsync();
    }
  });
}

for (const predecessorState of ['stopped', 'cancelled'] as const) {
  test(`a pending retry does not wait for a ${predecessorState} predecessor`, () => {
    const intent = { taskId: 'dependent', attempt: 1, status: 'pending', options: {} } as Parameters<
      typeof retryWait
    >[0];
    const task = { brief: { after: ['predecessor'] } } as Parameters<typeof retryWait>[1];
    expect(retryWait(intent, task, () => predecessorState, Date.now())).toBeNull();
  });
}

for (const terminal of ['stopped', 'cancelled'] as const) {
  test(`continuation overlap admission ignores a ${terminal} task`, () => {
    const h = harness();
    try {
      const task = h.tasks.dispatch(h.briefFile);
      h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.state = terminal;
      });
      const candidate = markdown
        .replace('goal: fixture', 'goal: fixture\ntitle: a different continuation')
        .replace('paths: [result.txt]', 'paths: [result.txt, new-result.txt]');
      const overlap = continuationOverlap(h.store.db, h.settings.stateDirectory, task.brief.goal, candidate, undefined);

      expect(overlap.after).not.toContain(task.id);
    } finally {
      h.dispose();
    }
  });
}
