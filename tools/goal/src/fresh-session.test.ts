import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';

// A successful worker that records whether each launch resumed a session.
const recordingCli = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('.temp/goal', { recursive: true });
appendFileSync('.temp/goal/launches.jsonl', JSON.stringify(process.argv.includes('resume')) + '\\n');
writeFileSync('result.txt', String(Date.now()));
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

test('retry --fresh-session starts the next attempt in a new session once; later retries resume again', async () => {
  const h = harness(recordingCli);
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    const retry = async (...flags: string[]) => {
      await runWorkerCommand('retry', [task.id, ...flags], { tasks: h.tasks, print() {} });
      job.resumePendingRetries();
      await job.drain();
    };
    await retry('--fresh-session');
    expect(h.store.task(task.id).freshSession).toBeUndefined();
    await retry();
    const resumed = readFileSync(join(task.worktree, '.temp/goal/launches.jsonl'), 'utf8').trim().split('\n');
    expect(resumed).toEqual(['false', 'false', 'true']);
    expect(h.store.task(task.id).currentAttempt).toBe(3);
    await expect(
      runWorkerCommand('retry', [task.id, '--fresh-session', '--proof-start'], { tasks: h.tasks }),
    ).rejects.toThrow('--fresh-session applies only to an ordinary retry');
  } finally {
    h.dispose();
  }
});
