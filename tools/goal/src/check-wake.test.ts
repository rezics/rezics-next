import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { workerPrompt } from './launch.ts';
import type { Task } from './types.ts';
import { harness } from './test-support.ts';

const waitingCli = `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const root = process.cwd();
if (process.argv.includes('resume')) {
  writeFileSync(join(root, '.temp/goal/resume-args.json'), JSON.stringify(process.argv));
  writeFileSync(join(root, '.temp/goal/resume-started'), 'yes');
  while (!existsSync(join(root, '.temp/goal/release-resume'))) await Bun.sleep(10);
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

test('waiting workers release their cap slot and resume the same session with every completed check result', async () => {
  const h = harness(waitingCli);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    const ref = { taskId: task.id, attempt: 1 };
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
    expect(prompt).toContain('check-b: exit status 9; assertion failed: expected 2; log path .temp/goal/checks/check-b.log');
    writeFileSync(join(task.worktree, '.temp/goal/release-resume'), 'yes');
    await recovery;
    expect(readFileSync(join(task.worktree, 'result.txt'), 'utf8')).toBe('resumed');
  } finally {
    h.dispose();
  }
});

test('a vanished check wakes a waiting attempt with the recovery fact', async () => {
  const h = harness(waitingCli);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    const resultDirectory = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(resultDirectory, { recursive: true });
    writeFileSync(join(resultDirectory, 'check-a.json'), JSON.stringify({ exitStatus: 0, summary: 'passed', logPath: 'a.log' }));
    const recovery = job.recoverOrphans();
    await waitFor(join(task.worktree, '.temp/goal/resume-started'));
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args.at(-1)).toContain('check check-b: run vanished or check host failed');
    writeFileSync(join(task.worktree, '.temp/goal/release-resume'), 'yes');
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
    expect(prompt).toContain('bun scripts/worker-check.ts --run -- <command...>');
    expect(prompt).toContain('keep working while checks run');
    expect(prompt).toContain('{"status":"waiting","checks":["<id>",...]}');
    expect(prompt).toContain('Never poll');
    expect(prompt).not.toContain('wait on that same check');
  } finally {
    h.dispose();
  }
});
