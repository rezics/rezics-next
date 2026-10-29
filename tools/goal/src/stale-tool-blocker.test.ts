import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRecord, readMeasurement } from './records.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';

const failingCommand = ['bun', 'test', 'tools/goal/src/failure.test.ts'];
const errorLine = 'ENOSPC: no space left on device on host b';

function failAttempt(h: ReturnType<typeof harness>, taskId: string, number: number, commandRan = false): void {
  const ref = { taskId, attempt: number };
  const attempt = h.store.updateAttempt(ref, (current) => {
    current.state = 'exited';
    current.endedAt = new Date().toISOString();
    current.failureKind = 'tool';
    current.failureCommand = failingCommand;
    current.blocker = errorLine;
    current.result = `BLOCKER: tool\n${errorLine}`;
  });
  h.store.updateTask(ref, (task) => {
    task.state = 'running';
  });
  h.store.putRecord(makeRecord(h.store.task(taskId), attempt, readMeasurement(attempt), 'stopped'));
  if (commandRan) {
    writeFileSync(
      attempt.logPath,
      `${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'check', command: failingCommand.join(' ') } })}\n`,
    );
  }
}

const captureAndSucceed = `#!/usr/bin/env bun
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = '.temp/goal-test-prompts';
mkdirSync(directory, { recursive: true });
const number = readdirSync(directory).length + 1;
writeFileSync(join(directory, String(number)), process.argv.at(-1) ?? '');
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

async function withRetryFixture(run: (job: WorkerJob, h: ReturnType<typeof harness>, taskId: string) => Promise<void>) {
  const h = harness(captureAndSucceed);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    failAttempt(h, task.id, 1);
    job.onAttemptExit({ taskId: task.id, attempt: 1 });
    await job.drain();
    await run(job, h, task.id);
  } finally {
    h.dispose();
  }
}

test('a stale tool blocker with no check or matching command gets one relaunch and the retry prompt says to rerun it', async () => {
  await withRetryFixture(async (job, h, taskId) => {
    failAttempt(h, taskId, 2);
    job.onAttemptExit({ taskId, attempt: 2 });
    await job.drain();

    expect(h.store.task(taskId).currentAttempt).toBe(3);
    expect(h.store.events(taskId, 2).map((event) => event.kind)).toContain('stale-tool-blocker-retry');
    expect(h.store.record({ taskId, attempt: 2 })?.escalation).not.toBe('stalled');
    const prompt = readFileSync(join(h.store.task(taskId).worktree, '.temp/goal-test-prompts', '3'), 'utf8');
    expect(prompt).toContain("The retry manifest records a failure from an earlier attempt");
    expect(prompt).toContain('Hosts and tools may have been fixed since then');
    expect(prompt).toContain('Rerun the failing command before reporting any blocker');
  });
});

test('a tool blocker whose failing command ran in this attempt is counted and escalated as environment', async () => {
  await withRetryFixture(async (job, h, taskId) => {
    failAttempt(h, taskId, 2, true);
    job.onAttemptExit({ taskId, attempt: 2 });
    await job.drain();

    expect(h.store.events(taskId, 2).map((event) => event.kind)).toContain('attempt-exit-classified');
    expect(h.store.events(taskId, 2).map((event) => event.kind)).not.toContain('stale-tool-blocker-retry');
    expect(h.store.attempt({ taskId, attempt: 2 }).escalation).toBe('environment');
    expect(h.store.task(taskId).currentAttempt).toBe(3);
  });
});

test('a second stale tool blocker on the task is counted normally', async () => {
  await withRetryFixture(async (job, h, taskId) => {
    failAttempt(h, taskId, 2);
    job.onAttemptExit({ taskId, attempt: 2 });
    await job.drain();

    failAttempt(h, taskId, 3);
    job.onAttemptExit({ taskId, attempt: 3 });
    await job.drain();

    expect(h.store.events(taskId, 2).map((event) => event.kind)).toContain('stale-tool-blocker-retry');
    expect(h.store.events(taskId, 3).map((event) => event.kind)).toContain('attempt-exit-classified');
    expect(h.store.events(taskId, 3).map((event) => event.kind)).not.toContain('stale-tool-blocker-retry');
    expect(h.store.record({ taskId, attempt: 3 })?.escalation).toBe('stalled');
    expect(h.store.task(taskId).state).toBe('stopped');
  });
});
