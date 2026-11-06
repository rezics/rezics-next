import { expect, test } from 'bun:test';
import { lstatSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LandingRequest } from './contracts.ts';
import { newestWorktreeMtime, WorkerJob } from './job.ts';
import { harness, tempDirectory } from './test-support.ts';

test('newest worktree mtime ignores node_modules and .temp', async () => {
  const root = tempDirectory();
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(root, '.temp'), { recursive: true });
  const kept = join(root, 'src/file.txt');
  writeFileSync(kept, 'kept');
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'ignored');
  writeFileSync(join(root, '.temp/scratch'), 'ignored');
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  utimesSync(root, past, past);
  utimesSync(join(root, 'src'), past, past);
  utimesSync(kept, past, past);
  utimesSync(join(root, 'node_modules/pkg/index.js'), future, future);
  utimesSync(join(root, '.temp/scratch'), future, future);
  expect(await newestWorktreeMtime(root)).toBe(lstatSync(kept).mtimeMs);
});

const fileActiveEmptyLogCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (let i = 0; i < 20; i++) {
  writeFileSync('progress.txt', String(i));
  await new Promise((resolve) => setTimeout(resolve, 80));
}
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt', 'progress.txt']);
spawnSync('git', ['commit', '-qm', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'file-active-worker'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

const idleEmptyLogCli = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.env.GOAL_ATTEMPT === '1') {
  await new Promise((resolve) => setTimeout(resolve, 600_000));
} else {
  writeFileSync('result.txt', 'accepted');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-qm', 'Complete fixture']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'idle-replacement'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
}
`;

test('A worker whose run log stays empty but whose worktree files or branch head change is not stopped as stalled; one with no log, worktree, commit or process CPU activity for the window is.', async () => {
  const active = harness(fileActiveEmptyLogCli);
  const landings: LandingRequest[] = [];
  active.settings.silenceMs = 400;
  active.settings.startGraceMs = 30_000;
  try {
    const task = active.tasks.dispatch(active.briefFile);
    const job = new WorkerJob(active.tasks, { enqueue: (request) => landings.push(request) }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    expect(active.store.task(task.id).currentAttempt).toBe(1);
    expect(active.store.attempt({ taskId: task.id, attempt: 1 }).failureKind).toBeNull();
    expect(landings).toHaveLength(1);
  } finally {
    await active.disposeAsync();
  }

  const idle = harness(idleEmptyLogCli);
  idle.settings.silenceMs = 400;
  idle.settings.startGraceMs = 30_000;
  try {
    const task = idle.tasks.dispatch(idle.briefFile);
    const job = new WorkerJob(idle.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    const first = idle.store.attempt({ taskId: task.id, attempt: 1 });
    expect(first.failureKind).toBe('tool');
    expect(first.result).toBe('stalled: no output for 1 minute');
  } finally {
    await idle.disposeAsync();
  }
}, 30_000);
