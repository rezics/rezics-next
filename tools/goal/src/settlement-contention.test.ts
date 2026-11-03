import { expect, test } from 'bun:test';
import type { LandingRequest, ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { harness } from './test-support.ts';
import { settle } from './settle.ts';
import { readControlPolicy } from './policy.ts';

test('settlement contention uses the configured retry schedule and stops at its bound', async () => {
  const h = harness();
  const write = h.store.write;
  let calls = 0;
  try {
    h.settings.policy = readControlPolicy({ worker: { settlementBackoffMs: [1] } });
    const task = h.tasks.dispatch(h.briefFile),
      worker = await h.tasks.retry(task.id);
    await worker.exited;
    h.store.write = () => {
      calls++;
      throw new Error('SQLITE_BUSY: database is locked');
    };
    await expect(settle(h.tasks, worker, { enqueue() {} })).rejects.toThrow('SQLITE_BUSY');
    expect(calls).toBe(2);
  } finally {
    h.store.write = write;
    await h.disposeAsync();
  }
});

// A successful worker whose exit coincides with another process holding the store's write lock for 1.5 seconds.
const lockingWorker = `#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
const marker = join(process.cwd(), '.store-locked');
const locker = "const { Database } = require('bun:sqlite'); const db = new Database(process.argv[1]);" +
  " db.exec('BEGIN IMMEDIATE'); require('node:fs').writeFileSync(process.argv[2], '1'); Bun.sleepSync(1500); db.exec('COMMIT');";
spawn(process.execPath, ['-e', locker, __GOAL_TEST_DATABASE_PATH__, marker], {
  cwd: dirname(__GOAL_TEST_DATABASE_PATH__), detached: true, stdio: 'ignore',
}).unref();
while (!existsSync(marker)) Bun.sleepSync(10);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:20}}));
`;

test('a successful exit outlasting the store busy timeout still lands once and is not a worker failure', async () => {
  const h = harness(lockingWorker);
  const landings: LandingRequest[] = [],
    inbox: ManagerEvent[] = [];
  try {
    h.store.db.exec('PRAGMA busy_timeout = 100');
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(
      h.tasks,
      { enqueue: (request) => landings.push(request) },
      { deliver: (event) => inbox.push(event) },
    );
    await job.start(task.id);
    await job.drain();
    const ref = { taskId: task.id, attempt: 1 };
    expect(landings.map((request) => request.taskId)).toEqual([task.id]);
    expect(h.store.task(task.id).state).toBe('landing');
    expect(h.store.attempt(ref).failureKind).toBeNull();
    expect(h.store.events(task.id, 1).map((event) => event.kind)).not.toContain('driver-environment-failure');
    expect(inbox).toEqual([]);
  } finally {
    await h.disposeAsync();
  }
}, 30_000);
