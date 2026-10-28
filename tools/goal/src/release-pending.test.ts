import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';
import { git } from './merge.ts';
import type { Attempt } from './types.ts';

function pendingAttempt(taskId: string, attempt: number): Attempt {
  return {
    taskId,
    attempt,
    state: 'pending',
    profile: { cli: 'codex', model: 'fixture', effort: 'medium', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    endedAt: null,
    process: null,
    driver: null,
    logPath: join('.temp', 'goal', 'runs', taskId, `${attempt}.jsonl`),
    evidencePath: join('.temp', 'goal', 'evidence', taskId, String(attempt)),
    auxiliaryProcesses: [],
    session: null,
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: null,
    result: '',
    blocker: null,
    approaches: [],
  };
}

function addPendingAttempt(h: ReturnType<typeof harness>, taskId: string, count = 1): void {
  for (let index = 0; index < count; index++) {
    const task = h.store.task(taskId);
    h.store.nextAttempt({ taskId, attempt: task.currentAttempt }, (attempt) => pendingAttempt(taskId, attempt));
  }
}

test('a held task with a pending attempt is released and started once its after-tasks integrate', async () => {
  const h = harness();
  try {
    writeFileSync(h.briefFile, markdown.replace('command: [bun, test]', 'command: ["true"]'));
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const first = h.tasks.dispatch(h.briefFile);
    const second = h.tasks.dispatch(h.briefFile);
    const heldBrief = join(h.root, '.temp/goal/held.md');
    writeFileSync(
      heldBrief,
      markdown
        .replace('command: [bun, test]', 'command: ["true"]')
        .replace('waiting: []', `waiting: []\nafter: [${first.id}, ${second.id}]`),
    );
    const held = h.tasks.dispatch(heldBrief);
    addPendingAttempt(h, held.id, 3);
    h.store.updateTask({ taskId: held.id, attempt: 3 }, (task) => {
      task.state = 'held';
    });

    for (const dependency of [first, second])
      h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (task) => {
        task.state = 'integrated';
        task.integratedCommit = git(h.root, 'rev-parse', 'HEAD');
      });

    await job.recoverOrphans();
    await job.recoverOrphans();
    await job.drain();

    expect(h.store.task(held.id).currentAttempt).toBe(4);
    expect(h.store.attempt({ taskId: held.id, attempt: 3 }).state).toBe('superseded');
    expect(h.store.attempt({ taskId: held.id, attempt: 4 }).state).toBe('exited');
  } finally {
    h.dispose();
  }
});

test('the host recovery sweep starts a ready task with a pending attempt and free lease', async () => {
  const h = harness();
  try {
    writeFileSync(h.briefFile, markdown.replace('command: [bun, test]', 'command: ["true"]'));
    const task = h.tasks.dispatch(h.briefFile);
    addPendingAttempt(h, task.id);
    h.settings.startGraceMs = 30_000;
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });

    await job.recoverOrphans();
    await job.drain();

    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).state).toBe('superseded');
    expect(h.store.attempt({ taskId: task.id, attempt: 2 }).state).toBe('exited');
  } finally {
    h.dispose();
  }
});

test('pending attempts remain rejected by held-task updates without explicit lease recovery', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    addPendingAttempt(h, task.id);
    expect(() =>
      h.store.updateHeldRetryTask({ taskId: task.id, attempt: 1 }, (current) => {
        current.state = 'held';
      }),
    ).toThrow('attempt pending');
  } finally {
    h.dispose();
  }
});
