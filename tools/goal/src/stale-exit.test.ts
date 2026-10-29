import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { launch } from './launch.ts';
import { settle } from './settle.ts';
import type { Attempt } from './types.ts';
import { harness } from './test-support.ts';

const launchError = "unexpected argument '-C'";

const waitingCli = `#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('resume')) {
  console.error(${JSON.stringify(launchError)});
  process.exit(2);
}
console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'waiting',summary:'checks running',checks:['check-a']})}}));
`;

function successOnResumeCli() {
  return `#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('resume')) {
  writeFileSync('result.txt', 'resumed');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-qm', 'Resume waiting worker']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
} else {
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'waiting',summary:'checks running',checks:['check-a']})}}));
}
`;
}

async function waitingAttempt(h: ReturnType<typeof harness>) {
  const task = h.tasks.dispatch(h.briefFile);
  const startedAt = new Date().toISOString();
  const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number): Attempt => ({
    taskId: task.id,
    attempt: number,
    state: 'pending',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt,
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${number}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(number)),
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
  }));
  mkdirSync(join(attempt.logPath, '..'), { recursive: true });
  writeFileSync(
    attempt.logPath,
    [
      { type: 'thread.started', thread_id: 'wake-session' },
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({ status: 'waiting', summary: 'checks running', checks: ['check-a'] }),
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  h.store.updateAttempt(attempt, (current) => {
    current.state = 'running';
  });
  h.store.updateTask(attempt, (current) => {
    current.state = 'running';
  });
  await settle(h.tasks, { attempt, exited: Promise.resolve({ code: 0, signal: null }) }, { enqueue() {} });
  const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
  mkdirSync(resultDirectory, { recursive: true });
  writeFileSync(
    join(resultDirectory, 'check-a.json'),
    JSON.stringify({ exitStatus: 0, summary: 'passed', logPath: '.temp/goal/checks/check-a.log' }),
  );
  return { task, ref: { taskId: task.id, attempt: 1 } };
}

test('a resumed launch failure is settled from its appended output, not the prior waiting result', async () => {
  const h = harness(waitingCli);
  try {
    const { task, ref } = await waitingAttempt(h);
    const attempt = h.store.attempt(ref);
    const resumed = await launch(
      h.store,
      task,
      attempt,
      h.settings.pools[0]!,
      'Resume after the check finished.',
      h.settings.codex,
      'wake-session',
    );
    await settle(h.tasks, resumed, { enqueue() {} });

    const settled = h.store.attempt(ref);
    const failure = h.store
      .events(ref.taskId, ref.attempt)
      .find((event) => event.kind === 'waiting-resume-launch-failed');
    expect(settled.state).toBe('waiting');
    expect(settled.result).toContain(launchError);
    expect(settled.result).not.toContain('checks running');
    expect(failure).toBeDefined();
    expect(JSON.parse(failure!.body)).toMatchObject({ count: 1, errorLine: launchError });
  } finally {
    h.dispose();
  }
});

test('repeated waiting resume launch failures stop after two retries and alert the supermanager once', async () => {
  const h = harness(waitingCli);
  const inbox: { managerId: string; kind: string; summary: string }[] = [];
  try {
    const { task, ref } = await waitingAttempt(h);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.recoverOrphans();

    const failures = h.store
      .events(ref.taskId, ref.attempt)
      .filter((event) => event.kind === 'waiting-resume-launch-failed');
    const reports = h.store.events(ref.taskId, ref.attempt).filter((event) => event.kind === 'manager-event');
    expect(failures).toHaveLength(3);
    expect(h.store.attempt(ref).state).toBe('exited');
    expect(h.store.attempt(ref).failureKind).toBe('tool');
    expect(reports).toHaveLength(1);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      managerId: h.settings.integration.supermanager,
      kind: 'environment',
    });
    expect(inbox[0]!.summary).toContain(launchError);
    expect(h.store.task(task.id).state).toBe('stopped');
  } finally {
    h.dispose();
  }
});

test('a resumed run with a new exit object settles from that object', async () => {
  const h = harness(successOnResumeCli());
  try {
    const { task, ref } = await waitingAttempt(h);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.recoverOrphans();

    expect(h.store.attempt(ref).state).toBe('exited');
    expect(h.store.attempt(ref).result).toContain('RESULT: success');
    expect(h.store.attempt(ref).failureKind).toBeNull();
    expect(
      h.store.events(ref.taskId, ref.attempt).filter((event) => event.kind === 'waiting-resume-launch-failed'),
    ).toEqual([]);
  } finally {
    h.dispose();
  }
});
