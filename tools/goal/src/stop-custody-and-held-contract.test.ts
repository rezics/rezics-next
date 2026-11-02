import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { WorkerJob } from './job.ts';
import { openDb } from './db.ts';
import { checkedProcessGroup, processIdentity, sameProcess, terminateProcessGroup } from './process.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks } from './tasks.ts';
import { harness, markdown } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';

const ownedWorker = `#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
writeFileSync('.stop-child', String(child.pid));
setInterval(() => {}, 1000);
`;

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

test('normal stop ends exactly its owned detached check process tree with honest terminal custody, no peer kill or duplicate new check', async () => {
  const h = harness(ownedWorker);
  let peerIdentity: ReturnType<typeof processIdentity> = null;
  let ownedIdentity: ReturnType<typeof processIdentity> = null;
  let controllerIdentity: ReturnType<typeof processIdentity> = null;
  let controller: ReturnType<typeof spawn> | undefined;
  let controllerClosed: Promise<void> | undefined;
  let workerExited: Promise<unknown> | undefined;
  let recoveryStore: WorkerStore | undefined;
  try {
    const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      peer.once('spawn', resolve);
      peer.once('error', reject);
    });
    peerIdentity = processIdentity(peer.pid!);
    expect(peerIdentity?.group).toBe(peer.pid);

    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    workerExited = worker.exited;
    const ref = worker.attempt;
    const attempt = h.store.attempt(ref);
    ownedIdentity = attempt.process;
    expect(ownedIdentity).not.toBeNull();
    const childFile = join(h.store.task(task.id).worktree, '.stop-child');
    await waitFor(() => existsSync(childFile), 'worker did not start its owned child');
    expect(processIdentity(Number(readFileSync(childFile, 'utf8')))?.group).toBe(ownedIdentity!.group);
    h.tasks.queueRetry(task.id);

    const localPath = join(h.settings.stateDirectory, 'local.json');
    const local = JSON.parse(readFileSync(localPath, 'utf8')) as Record<string, unknown>;
    local.terminationGraceMs = 15_000;
    writeFileSync(localPath, JSON.stringify(local));
    controller = spawn(process.execPath, [join(import.meta.dir, 'cli.ts'), 'stop', task.id], {
      cwd: h.root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, GOAL_MAIN_CHECKOUT: h.root, GOAL_TASK_ID: '', GOAL_ATTEMPT: '' },
    });
    controllerClosed = new Promise((resolve) => controller!.once('close', () => resolve()));
    await waitFor(
      () => h.store.attempt(ref).terminationIntent?.state === 'requested',
      'stop command did not persist its request',
    );
    controllerIdentity = processIdentity(controller.pid!);
    expect(controllerIdentity).not.toBeNull();
    const status: string[] = [];
    await runWorkerCommand('status', [task.id], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      env: {},
      print: (line) => status.push(line),
    });
    expect(status.join('\n')).toContain('"processIdentity": "known"');
    expect(status.join('\n')).toContain('"state": "requested"');
    if (sameProcess(controllerIdentity!)) process.kill(controllerIdentity!.pid, 'SIGKILL');
    await controllerClosed;

    recoveryStore = new WorkerStore(openDb(join(h.settings.stateDirectory, 'goal.sqlite')));
    const recoverySettings = { ...h.settings, terminationGraceMs: 50 };
    const recovery = new WorkerJob(new WorkerTasks(recoverySettings, recoveryStore), { enqueue() {} }, { deliver() {} });
    await recovery.recoverOrphans();
    await h.tasks.stop(task.id);

    const stopped = h.store.attempt(ref);
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(stopped.terminationIntent).toMatchObject({ operation: 'stop', state: 'complete', processIdentity: 'known' });
    expect(checkedProcessGroup(ownedIdentity!)).toEqual([]);
    expect(sameProcess(peerIdentity!)).toBe(true);
    expect(h.store.attempts(task.id)).toHaveLength(1);
    expect(h.store.events(task.id, ref.attempt).filter((event) => event.kind === 'stopped')).toHaveLength(1);
    expect(h.store.events(task.id, ref.attempt).filter((event) => event.kind === 'termination-requested')).toHaveLength(1);
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'abandoned', abandonedBy: 'stop' });
  } finally {
    if (controllerIdentity && sameProcess(controllerIdentity)) process.kill(controllerIdentity.pid, 'SIGKILL');
    await controllerClosed?.catch(() => {});
    if (ownedIdentity) await terminateProcessGroup(ownedIdentity, 50).catch(() => {});
    if (peerIdentity) await terminateProcessGroup(peerIdentity, 50).catch(() => {});
    await workerExited?.catch(() => {});
    recoveryStore?.db.close();
    h.dispose();
  }
});

test('unstarted held retry --brief preserves task identity, attempt 0, work, dependencies, and releases once', async () => {
  const h = harness();
  try {
    const oldDependency = h.tasks.dispatch(h.briefFile);
    const newDependency = h.tasks.dispatch(h.briefFile);
    const heldBrief = join(h.settings.stateDirectory, 'held-original.md');
    writeFileSync(heldBrief, markdown.replace('waiting: []', `waiting: []\nafter: [${oldDependency.id}]`));
    const task = h.tasks.dispatch(heldBrief);
    const work = join(task.worktree, 'operator-work.txt');
    writeFileSync(work, 'keep this work\n');

    const amendedBrief = join(h.settings.stateDirectory, 'held-amended.md');
    writeFileSync(amendedBrief, markdown.replace('waiting: []', `waiting: []\nafter: [${newDependency.id}]`));
    await runWorkerCommand('retry', [task.id, '--brief', amendedBrief], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      env: {},
      print() {},
    });
    expect(h.store.task(task.id)).toMatchObject({
      id: task.id,
      state: 'held',
      currentAttempt: 0,
      branch: task.branch,
      worktree: task.worktree,
      brief: { after: [newDependency.id] },
    });
    expect(readFileSync(work, 'utf8')).toBe('keep this work\n');
    expect(h.store.attempts(task.id)).toEqual([]);

    h.store.updateTask({ taskId: newDependency.id, attempt: 0 }, (current) => {
      current.state = 'merged';
    });
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.recoverOrphans();
    expect(h.store.task(task.id)).toMatchObject({ id: task.id, currentAttempt: 1, branch: task.branch, worktree: task.worktree });
    expect(h.store.events(task.id).filter((event) => event.kind === 'held-task-released')).toHaveLength(1);
    expect(readFileSync(work, 'utf8')).toBe('keep this work\n');
  } finally {
    await h.disposeAsync();
  }
});
