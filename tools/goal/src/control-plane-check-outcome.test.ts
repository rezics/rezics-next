import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateOutcome, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';

const capturePrompt = `#!/usr/bin/env bun
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = '.temp/goal-test-prompts';
mkdirSync(directory, { recursive: true });
const number = readdirSync(directory).length + 1;
writeFileSync(join(directory, String(number)), process.argv.at(-1) ?? '');
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'BLOCKER: fixing the declared assertion'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
const failedCheck: GateOutcome = {
  taskId: '',
  attempt: 1,
  passed: false,
  stage: 'gate',
  failedCommand: ['bun', 'test', 'tools/goal/src'],
  firstFailure: {
    fingerprint: 'control-plane-check-failure',
    assertion: 'assertion in a test outside the declared paths',
    excerpt: 'tools/goal/src/failing.test.ts: AssertionError: control-plane check failed',
  },
  logPath: 'fixture-gate.log',
  hostMs: 25,
  changedFiles: ['tools/goal/src/result.ts'],
  diffLines: 201,
};

function controlPlaneBrief(path = 'tools/goal/src/result.ts'): string {
  return markdown.replace('goal: fixture', 'goal: control-plane').replace('paths: [result.txt]', `paths: [${path}]`);
}

test('a control-plane task refused by its control-plane checks is retried with the failure as evidence, not stopped as scope growth', async () => {
  const h = harness(capturePrompt);
  const inbox: ManagerEvent[] = [];
  try {
    writeFileSync(h.briefFile, controlPlaneBrief());
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.start(task.id);

    job.onGateOutcome({ ...failedCheck, taskId: task.id });
    await job.drain();

    expect(h.store.record({ taskId: task.id, attempt: 1 })?.escalation).toBe('new-failure');
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(inbox).toEqual([]);
    const attempts = [1, 2].map((number) => h.store.attempt({ taskId: task.id, attempt: number }));
    expect(attempts[1]?.previousFailure).toBe(failedCheck.firstFailure!.fingerprint);
    const prompts = readdirSync(join(task.worktree, '.temp/goal-test-prompts')).sort();
    expect(prompts).toEqual(['1', '2']);
    const retryPrompt = readFileSync(join(task.worktree, '.temp/goal-test-prompts', '2'), 'utf8');
    expect(retryPrompt).toContain('control-plane check failed');
    expect(retryPrompt).toContain('tools/goal/src/failing.test.ts');
    const evidence = JSON.parse(readFileSync(join(attempts[0]!.evidencePath, 'failure.json'), 'utf8')) as {
      assertion: string;
      manifest: string;
    };
    expect(evidence.assertion).toBe(failedCheck.firstFailure!.assertion);
    expect(evidence.manifest).toContain('First failing command: bun test tools/goal/src');
  } finally {
    h.dispose();
  }
}, 60_000);

test('a control-plane task with a changed path outside its brief still escalates as scope growth', async () => {
  const h = harness();
  const inbox: ManagerEvent[] = [];
  try {
    writeFileSync(h.briefFile, controlPlaneBrief());
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.start(task.id);

    job.onGateOutcome({ ...failedCheck, taskId: task.id, changedFiles: ['tools/goal/src/outside.ts'], diffLines: 1 });
    await job.drain();

    expect(h.store.record({ taskId: task.id, attempt: 1 })?.escalation).toBe('scope-growth');
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(inbox.map((event) => event.kind)).toEqual(['scope-growth']);
  } finally {
    h.dispose();
  }
}, 60_000);
