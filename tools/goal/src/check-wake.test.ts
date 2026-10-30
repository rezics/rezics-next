import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { workerPrompt } from './launch.ts';
import { settle } from './settle.ts';
import type { Attempt, Task } from './types.ts';
import { harness } from './test-support.ts';

const waitingCli = `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const root = process.cwd();
if (process.argv.includes('resume')) {
  writeFileSync(join(root, '.temp/goal/resume-args.json'), JSON.stringify(process.argv));
  writeFileSync(join(root, '.temp/goal/resume-started'), 'yes');
  await Bun.sleep(150);
  writeFileSync('result.txt', 'resumed');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-m', 'Resume check worker']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
} else {
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'waiting',summary:'checks running',checks:['check-a','check-b']})}}));
}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

async function waitFor(path: string): Promise<void> {
  for (let n = 0; n < 300; n++) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function startWaitingAttempt(h: ReturnType<typeof harness>) {
  const task = h.tasks.dispatch(h.briefFile);
  const startedAt = new Date().toISOString();
  const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n): Attempt => ({
    taskId: task.id,
    attempt: n,
    state: 'pending',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt,
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${n}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(n)),
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
          text: JSON.stringify({ status: 'waiting', summary: 'checks running', checks: ['check-a', 'check-b'] }),
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
  const landings: unknown[] = [];
  await settle(
    h.tasks,
    { attempt, exited: Promise.resolve({ code: 0, signal: null }) },
    { enqueue: (request) => landings.push(request) },
  );
  expect(landings).toHaveLength(0);
  return { task, ref: { taskId: task.id, attempt: 1 } };
}

test('waiting workers release their cap slot and resume the same session with every completed check result', async () => {
  const h = harness(waitingCli);
  try {
    const { task, ref } = await startWaitingAttempt(h);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const waiting = h.store.attempt(ref);
    expect(waiting.state).toBe('waiting');
    expect(waiting.checks).toEqual(['check-a', 'check-b']);
    expect(waiting.session).toBe('wake-session');
    expect(waiting.endedAt).toBeNull();
    expect(h.store.runningAttemptsCount()).toBe(0);

    const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(resultDirectory, { recursive: true });
    for (const [id, status, summary] of [
      ['check-a', 0, 'passed'],
      ['check-b', 9, 'assertion failed: expected 2'],
    ] as const)
      writeFileSync(
        join(resultDirectory, `${id}.json`),
        JSON.stringify({ exitStatus: status, failureSummary: summary, logPath: `.temp/goal/checks/${id}.log` }),
      );

    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    expect(h.store.attempt(ref).state).toBe('running');
    expect(h.store.runningAttemptsCount()).toBe(1);
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args).toContain('resume');
    expect(args).toContain('wake-session');
    const prompt = args.at(-1)!;
    expect(prompt).toContain('check-a: exit status 0; passed; log path .temp/goal/checks/check-a.log');
    expect(prompt).toContain(
      'check-b: exit status 9; assertion failed: expected 2; log path .temp/goal/checks/check-b.log',
    );
    await recovery;
    expect(readFileSync(join(task.worktree, 'result.txt'), 'utf8')).toBe('resumed');
  } finally {
    h.dispose();
  }
});

test('a vanished check wakes a waiting attempt with the recovery fact', async () => {
  const h = harness(waitingCli);
  try {
    const { task } = await startWaitingAttempt(h);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(resultDirectory, { recursive: true });
    writeFileSync(
      join(resultDirectory, 'check-a.json'),
      JSON.stringify({ exitStatus: 0, summary: 'passed', logPath: 'a.log' }),
    );
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args.at(-1)).toContain('check check-b: run vanished or check host failed');
    await recovery;
  } finally {
    h.dispose();
  }
});

test('a check whose start record shows a live runner keeps the attempt waiting; a dead runner wakes it', async () => {
  const h = harness(waitingCli);
  try {
    const { task, ref } = await startWaitingAttempt(h);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(resultDirectory, { recursive: true });
    writeFileSync(
      join(resultDirectory, 'check-a.json'),
      JSON.stringify({ exitCode: 0, status: 'finished', log: 'a.log' }),
    );
    // The record worker-check writes when a check starts, with this test's own (live) process as the runner.
    writeFileSync(
      join(resultDirectory, 'check-b.json'),
      JSON.stringify({ status: 'running', runnerPid: process.pid, runnerHost: hostname(), log: 'b.log' }),
    );
    await job.recoverOrphans();
    expect(h.store.attempt(ref).state).toBe('waiting');
    expect(existsSync(join(task.worktree, '.temp/goal/resume-started'))).toBe(false);

    const dead = Bun.spawnSync(['true']).pid;
    writeFileSync(
      join(resultDirectory, 'check-b.json'),
      JSON.stringify({ status: 'running', runnerPid: dead, runnerHost: hostname(), log: 'b.log' }),
    );
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args.at(-1)).toContain(`check check-b: run vanished (runner ${dead} exited without a result)`);
    await recovery;
  } finally {
    h.dispose();
  }
});

test('worker instructions start detached checks, keep working, and return waiting without polling', () => {
  const h = harness();
  try {
    const task = {
      worktree: h.root,
      branch: 'worker/test',
      brief: { markdown: 'Do work', kind: 'implementation' },
    } as unknown as Task;
    mkdirSync(join(h.root, 'scripts'), { recursive: true });
    writeFileSync(join(h.root, 'scripts/worker-check.ts'), '');
    const prompt = workerPrompt(task, undefined, undefined, [], h.root);
    expect(prompt).toContain('bun scripts/worker-check.ts -- <command...>');
    expect(prompt).toContain('run your acceptance command once after your last relevant edit');
    expect(prompt).toContain('Goal owns check continuation');
    expect(prompt).toContain('`{"status":"waiting","checks":["<bare UUID>"]}`');
    expect(prompt).toContain('`{"status":"waiting","summary":"acceptance check is running","blocker":null,"checks":["00000000-0000-4000-8000-000000000000"],"approaches":[]}`');
    expect(prompt).toContain('Every checks entry must be the bare UUID string');
    expect(prompt).toContain('Do not invoke `bun scripts/worker-check.ts --wait <id>`');
    expect(prompt).toContain('A previous session may contain the superseded instruction');
    expect(prompt).toContain('do not follow it or invoke `--wait`');
    expect(prompt).toContain('or start a duplicate check');
    expect(prompt).toContain('Do not run the root typecheck, affected checks or other regression checks yourself');
    expect(prompt).toContain('landing batch runs the root typecheck, affected checks for every changed path');
    const pollingInstructions = prompt
      .split(/(?<=[.!?])\s+/)
      .filter(
        (sentence) =>
          /\b(?:poll(?:ing)?|--wait)\b/i.test(sentence) &&
          !/\b(?:do not|don't|never|obsolete|superseded|previous session may contain)\b/i.test(sentence),
      );
    expect(pollingInstructions).toEqual([]);
    expect(prompt).not.toContain('{"status":"waiting","checks":["<id>",...]}');
    expect(prompt).not.toContain('Never poll');
  } finally {
    h.dispose();
  }
});
