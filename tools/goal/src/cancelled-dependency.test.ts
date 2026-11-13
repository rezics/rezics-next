import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';
import { StaleAttemptError, type ManagerEvent } from './contracts.ts';
import { runWorkerCommand } from './worker-commands.ts';

test.each([0, 3])(
  'cancelling generation %i sends each manager owning a task held after it one event naming the held tasks',
  async (generation) => {
    const h = harness();
    try {
      const blocker = h.tasks.dispatch(h.briefFile);
      const dispatchHeld = async (name: string, manager: string) => {
        const path = join(h.root, `.temp/goal/${name}.md`);
        writeFileSync(
          path,
          markdown
            .replace('goal: fixture', `goal: fixture\nmanager: ${manager}`)
            .replace('waiting: []', `waiting: []\nafter: [${blocker.id}]`),
        );
        return h.tasks.dispatch(path);
      };
      const first = await dispatchHeld('first', 'manager-a');
      const second = await dispatchHeld('second', 'manager-a');
      const third = await dispatchHeld('third', 'manager-b');

      for (let attempt = 0; attempt < generation; attempt++) {
        const worker = await h.tasks.retry(blocker.id);
        await worker.exited;
      }
      const options = { settings: h.settings, store: h.store, tasks: h.tasks, env: {} };
      await expect(
        runWorkerCommand('cancel', [blocker.id], {
          ...options,
          env: { GOAL_TASK_ID: blocker.id, GOAL_ATTEMPT: String(generation + 1) },
        }),
      ).rejects.toThrow(StaleAttemptError);
      expect(h.store.task(blocker.id).state).not.toBe('cancelled');
      expect(await runWorkerCommand('cancel', [blocker.id], options)).toBe(0);
      expect(h.store.task(blocker.id)).toMatchObject({ state: 'cancelled', currentAttempt: generation });
      if (generation > 0)
        expect(() => h.store.event({ taskId: blocker.id, attempt: generation }, 'late-worker-write', {})).toThrow(
          StaleAttemptError,
        );

      const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
      const notices = ['manager-a', 'manager-b'].flatMap((manager) =>
        inbox.pending(manager).map(({ event }) => event as ManagerEvent),
      );
      expect(notices).toHaveLength(2);
      expect(notices.map(({ managerId, taskId, kind, summary }) => [managerId, taskId, kind, summary])).toEqual([
        ['manager-a', blocker.id, 'instruction', expect.stringContaining(`${first.id}, ${second.id}`)],
        ['manager-b', blocker.id, 'instruction', expect.stringContaining(third.id)],
      ]);
    } finally {
      await h.disposeAsync();
    }
  },
);

test('the host reports a held task whose dependency is already cancelled once, not on every sweep', async () => {
  const h = harness(),
    events: ManagerEvent[] = [];
  try {
    const blocker = h.tasks.dispatch(h.briefFile);
    const path = join(h.root, '.temp/goal/held.md');
    writeFileSync(path, markdown.replace('waiting: []', `waiting: []\nafter: [${blocker.id}]`));
    const held = h.tasks.dispatch(path);
    await h.tasks.cancel(blocker.id);
    // Simulate a historical cancellation that predates the cancellation notification.
    h.store.db.query('DELETE FROM manager_inbox WHERE manager = ?').run('fixture');
    h.store.db
      .query(
        "DELETE FROM worker_events WHERE task_id = ? AND kind IN ('cancelled-dependency-notice','dropped-dependency-notice')",
      )
      .run(blocker.id);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => events.push(event) });

    await job.recoverOrphans({ adoptRunning: false });
    await job.recoverOrphans({ adoptRunning: false });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ managerId: 'fixture', taskId: blocker.id, kind: 'instruction' });
    expect(events[0]?.summary).toContain(held.id);
  } finally {
    h.dispose();
  }
});

test('cancelling a source-required predecessor keeps its dependent held and sends one actionable notice', async () => {
  const h = harness(),
    events: ManagerEvent[] = [];
  try {
    const blocker = h.tasks.dispatch(h.briefFile);
    const path = join(h.root, '.temp/goal/source-held.md');
    writeFileSync(
      path,
      markdown.replace('waiting: []', `waiting: []\nafter: [${blocker.id}]\nafterSource: [${blocker.id}]`),
    );
    const held = h.tasks.dispatch(path);

    await h.tasks.cancel(blocker.id);
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    const pending = inbox.pending('fixture').map(({ event }) => event as ManagerEvent);
    expect(h.store.task(held.id)).toMatchObject({ state: 'held', currentAttempt: 0 });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.summary).toContain('remain held');
    expect(pending[0]?.summary).toContain('authenticated reshape');

    const historical = h.tasks.dispatch(h.briefFile);
    const historicalPath = join(h.root, '.temp/goal/historical-source-held.md');
    writeFileSync(
      historicalPath,
      markdown.replace('waiting: []', `waiting: []\nafter: [${historical.id}]\nafterSource: [${historical.id}]`),
    );
    const historicalHeld = h.tasks.dispatch(historicalPath);
    h.store.updateTask({ taskId: historical.id, attempt: 0 }, (task) => {
      task.state = 'stopped';
    });
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => events.push(event) });
    await job.recoverOrphans({ adoptRunning: false });
    await job.recoverOrphans({ adoptRunning: false });

    expect(h.store.task(held.id)).toMatchObject({ state: 'held', currentAttempt: 0 });
    expect(h.store.task(historicalHeld.id)).toMatchObject({ state: 'held', currentAttempt: 0 });
    expect(inbox.pending('fixture')).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ taskId: historical.id, kind: 'instruction' });
    expect(events[0]?.summary).toContain(historicalHeld.id);
    expect(events[0]?.summary).toContain('authenticated reshape');
  } finally {
    await h.disposeAsync();
  }
});

test('a dropped-dependency notice refused by the attempt fence does not stop other notices', async () => {
  const h = harness(),
    events: ManagerEvent[] = [];
  try {
    const refusedBlocker = h.tasks.dispatch(h.briefFile);
    const otherBlocker = h.tasks.dispatch(h.briefFile);
    const dispatchHeld = (name: string, blockerId: string) => {
      const path = join(h.root, `.temp/goal/${name}.md`);
      writeFileSync(path, markdown.replace('waiting: []', `waiting: []\nafter: [${blockerId}]`));
      return h.tasks.dispatch(path);
    };
    dispatchHeld('refused', refusedBlocker.id);
    dispatchHeld('other', otherBlocker.id);
    await h.tasks.cancel(refusedBlocker.id);
    await h.tasks.cancel(otherBlocker.id);
    h.store.db.query('DELETE FROM manager_inbox WHERE manager = ?').run('fixture');
    h.store.db
      .query("DELETE FROM worker_events WHERE kind IN ('cancelled-dependency-notice','dropped-dependency-notice')")
      .run();
    const notify = h.store.notifyDroppedDependency.bind(h.store);
    h.store.notifyDroppedDependency = ((ref, event, deliver) => {
      if (ref.taskId === refusedBlocker.id) throw new StaleAttemptError(ref, ref.attempt);
      notify(ref, event, deliver);
    }) as typeof h.store.notifyDroppedDependency;
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => events.push(event) });

    await job.recoverOrphans({ adoptRunning: false });

    expect(events.map(({ taskId }) => taskId)).toEqual([otherBlocker.id]);
  } finally {
    h.dispose();
  }
});
