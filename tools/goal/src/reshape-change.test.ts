import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';

const controlledWorker = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.env.GOAL_ATTEMPT === '1') {
  console.log(JSON.stringify({type:'thread.started',thread_id:'held-attempt'}));
  setInterval(() => {}, 1000);
} else {
  writeFileSync('result.txt', 'accepted');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-m', 'Complete fixture']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'replacement'}));
  console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'RESULT: success'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:20}}));
}
`;

function hash(markdownText: string): string {
  return createHash('sha256').update(markdownText.replace(/\r\n?/g, '\n').trimEnd()).digest('hex');
}

test('retry --brief leaves a running attempt in place when its normalized contract is unchanged', async () => {
  const h = harness(controlledWorker);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).state).toBe('running');

    const equivalent = join(h.root, '.temp/goal/equivalent.md');
    writeFileSync(equivalent, `${markdown.replace(/\n/g, '\r\n')}\r\n`);
    const output: string[] = [];
    const status = await runWorkerCommand('retry', [task.id, '--brief', equivalent], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print: (value) => output.push(value),
      env: {},
    });

    expect(status).toBe(0);
    expect(output).toContain('The contract is unchanged.');
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).state).toBe('running');
    expect(h.store.attempts(task.id)).toHaveLength(1);
  } finally {
    const tasks = h.store.tasks();
    if (tasks[0]?.state === 'running') await h.tasks.stop(tasks[0].id);
    h.dispose();
  }
}, 30_000);

test('retry --brief replaces a changed contract and records both brief hashes on the new attempt', async () => {
  const h = harness(controlledWorker);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    const changedText = `${markdown.trimEnd()}\n\nAdd a cost estimate to the result.\n`;
    const changed = join(h.root, '.temp/goal/changed.md');
    writeFileSync(changed, changedText);
    const status = await runWorkerCommand('retry', [task.id, '--brief', changed], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print() {},
      env: {},
    });

    expect(status).toBe(0);
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.retryIntent({ taskId: task.id, attempt: 1 })?.status).toBe('pending');
    const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await host.recoverOrphans();
    await host.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).state).toBe('superseded');
    expect(h.store.task(task.id).brief.markdown).toBe(changedText);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 })).toMatchObject({
      previousBriefHash: hash(markdown),
      newBriefHash: hash(changedText),
    });
  } finally {
    const tasks = h.store.tasks();
    if (tasks[0]?.state === 'running') await h.tasks.stop(tasks[0].id);
    h.dispose();
  }
}, 30_000);

test('plain retry records a stopped task for the host to start', async () => {
  const h = harness(controlledWorker);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    await h.tasks.stop(task.id);
    expect(h.store.task(task.id).state).toBe('stopped');

    const status = await runWorkerCommand('retry', [task.id], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print() {},
      env: {},
    });

    expect(status).toBe(0);
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.retryIntent({ taskId: task.id, attempt: 1 })?.status).toBe('pending');
    const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await host.recoverOrphans();
    await host.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 }).state).not.toBe('pending');
  } finally {
    const tasks = h.store.tasks();
    if (tasks[0]?.state === 'running') await h.tasks.stop(tasks[0].id);
    h.dispose();
  }
}, 30_000);
