import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';
import type { ManagerEvent } from './contracts.ts';

test('cancelling a task sends each manager owning a task held after it one event naming the held tasks', async () => {
  const h = harness();
  try {
    const blocker = h.tasks.dispatch(h.briefFile);
    const dispatchHeld = async (name: string, manager: string) => {
      const path = join(h.root, `.temp/goal/${name}.md`);
      writeFileSync(path, markdown.replace('goal: fixture', `goal: fixture\nmanager: ${manager}`)
        .replace('waiting: []', `waiting: []\nafter: [${blocker.id}]`));
      return h.tasks.dispatch(path);
    };
    const first = await dispatchHeld('first', 'manager-a');
    const second = await dispatchHeld('second', 'manager-a');
    const third = await dispatchHeld('third', 'manager-b');

    await h.tasks.cancel(blocker.id);

    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    const notices = ['manager-a', 'manager-b'].flatMap((manager) => inbox.pending(manager).map(({ event }) => event as ManagerEvent));
    expect(notices).toHaveLength(2);
    expect(notices.map(({ managerId, taskId, kind, summary }) => [managerId, taskId, kind, summary])).toEqual([
      ['manager-a', blocker.id, 'instruction', expect.stringContaining(`${first.id}, ${second.id}`)],
      ['manager-b', blocker.id, 'instruction', expect.stringContaining(third.id)],
    ]);
  } finally { h.dispose(); }
});

test('the host reports a held task whose dependency is already cancelled once, not on every sweep', async () => {
  const h = harness(), events: ManagerEvent[] = [];
  try {
    const blocker = h.tasks.dispatch(h.briefFile);
    const path = join(h.root, '.temp/goal/held.md');
    writeFileSync(path, markdown.replace('waiting: []', `waiting: []\nafter: [${blocker.id}]`));
    const held = h.tasks.dispatch(path);
    await h.tasks.cancel(blocker.id);
    // Simulate a historical cancellation that predates the cancellation notification.
    h.store.db.query("DELETE FROM manager_inbox WHERE manager = ?").run('fixture');
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: event => events.push(event) });

    await job.recoverOrphans({ adoptRunning: false });
    await job.recoverOrphans({ adoptRunning: false });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ managerId: 'fixture', taskId: held.id, kind: 'instruction' });
    expect(events[0]?.summary).toContain(blocker.id);
  } finally { h.dispose(); }
});
