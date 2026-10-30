import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MergeTrain } from './merge-train.ts';
import { WorkerJob } from './job.ts';
import { SqliteLandingQueue } from './land.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { git, WorkerTasks } from './tasks.ts';
import type { GateOutcome } from './contracts.ts';
import { integrationHarness } from './test-support.ts';

const REPEATED_REDACTED_FINGERPRINT = 'same-redacted-could-not-apply-fingerprint';

function durableJob(h: ReturnType<typeof integrationHarness>): WorkerJob {
  return new WorkerJob(
    h.tasks,
    h.queue,
    new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory),
  );
}

async function startWorker(
  h: ReturnType<typeof integrationHarness>,
  job: WorkerJob,
  file: string,
  goal: 'control-plane' | 'fixture' = 'control-plane',
  content = `worker version for ${file}\n`,
) {
  const task = h.dispatch(file, [], ['true'], goal);
  writePlan(task.worktree, file, content);
  installNoProgressWorker(h);
  await job.start(task.id);
  await job.drain();
  return task;
}

function writePlan(worktree: string, file: string, content: string): void {
  writeFileSync(join(worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content }));
}

function resetWorkerBranch(worktree: string, commit: string): void {
  git(worktree, ['reset', '--hard', commit]);
}

function advanceMain(h: ReturnType<typeof integrationHarness>, file: string, content: string): string {
  mkdirSync(dirname(join(h.root, file)), { recursive: true });
  writeFileSync(join(h.root, file), content);
  git(h.root, ['add', '--', file]);
  git(h.root, ['commit', '-m', 'Reorganize Storybook on main']);
  return git(h.root, ['rev-parse', 'HEAD']);
}

function advanceMainFiles(h: ReturnType<typeof integrationHarness>, files: readonly { path: string; content: string }[]) {
  for (const file of files) {
    mkdirSync(dirname(join(h.root, file.path)), { recursive: true });
    writeFileSync(join(h.root, file.path), file.content);
  }
  git(h.root, ['add', '--', ...files.map((file) => file.path)]);
  git(h.root, ['commit', '-m', 'Reorganize Storybook files on main']);
  return git(h.root, ['rev-parse', 'HEAD']);
}

async function runTrain(
  h: ReturnType<typeof integrationHarness>,
  job: WorkerJob,
  options: { sameRedactedFingerprint?: boolean } = {},
): Promise<GateOutcome[]> {
  const outcomes: GateOutcome[] = [];
  await new MergeTrain({
    ...h.settings,
    queue: h.queue,
    fence: h.store,
    sink: {
      onGateOutcome(outcome) {
        outcomes.push(outcome);
        const delivered =
          options.sameRedactedFingerprint && outcome.firstFailure
            ? {
                ...outcome,
                firstFailure: { ...outcome.firstFailure, fingerprint: REPEATED_REDACTED_FINGERPRINT },
              }
            : outcome;
        job.onGateOutcome(delivered);
      },
    },
  }).run();
  await job.drain();
  return outcomes;
}

function rewriteStoredOutcome(
  h: ReturnType<typeof integrationHarness>,
  taskId: string,
  attempt: number,
  update: (outcome: GateOutcome) => void,
): void {
  const event = h.store.events(taskId, attempt).find((candidate) => candidate.kind === 'gate-outcome');
  if (!event) throw new Error(`missing durable gate outcome for attempt ${attempt}`);
  const body = JSON.parse(event.body) as GateOutcome;
  update(body);
  h.store.db.query('UPDATE worker_events SET body=? WHERE sequence=?').run(JSON.stringify(body), event.sequence);
}

test('A resolution attempt that conflicts with a NEW integration head is never stopped by either old rule', async () => {
  const h = integrationHarness();
  const job = durableJob(h);
  try {
    const file = 'tools/goal/src/storybook-entry.ts';
    const task = await startWorker(h, job, file);
    const source = h.head(task.branch);
    const firstTarget = advanceMain(h, file, 'main Storybook organization one\n');

    const first = await runTrain(h, job, { sameRedactedFingerprint: true });
    expect(first).toHaveLength(1);
    expect(first[0]!.rebaseConflict).toEqual({ targetHead: firstTarget, workerCommit: source, paths: [file] });
    expect(h.store.task(task.id).currentAttempt).toBe(2);

    resetWorkerBranch(task.worktree, source);
    const secondTarget = advanceMain(h, file, 'main Storybook reorganization two\n');
    const second = await runTrain(h, job, { sameRedactedFingerprint: true });

    expect(second[0]!.rebaseConflict).toEqual({ targetHead: secondTarget, workerCommit: source, paths: [file] });
    expect(secondTarget).not.toBe(firstTarget);
    expect(h.store.record({ taskId: task.id, attempt: 1 })?.firstFailure).toBe(REPEATED_REDACTED_FINGERPRINT);
    expect(h.store.record({ taskId: task.id, attempt: 2 })?.firstFailure).toBe(REPEATED_REDACTED_FINGERPRINT);
    expect(h.store.task(task.id).currentAttempt).toBe(3);
    expect(h.store.events(task.id).filter((event) => event.kind === 'manager-event')).toEqual([]);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 }).profile).toEqual(
      h.store.attempt({ taskId: task.id, attempt: 1 }).profile,
    );
  } finally {
    h.dispose();
  }
}, 60_000);

test('Identical redacted failure fingerprints on different files/heads or with new worker commit do not stop progress', async () => {
  const h = integrationHarness();
  const job = durableJob(h);
  try {
    const fileA = 'tools/goal/src/storybook-entry.ts';
    const fileB = 'tools/goal/src/storybook-layout.ts';
    const task = await startWorker(h, job, fileA);
    const firstTarget = advanceMain(h, fileA, 'main Storybook entry reorganization\n');
    const first = await runTrain(h, job, { sameRedactedFingerprint: true });
    const firstSource = first[0]!.rebaseConflict!.workerCommit;

    const revisedContent = `${readFileSync(join(task.worktree, fileA), 'utf8')}worker follow-up\n`;
    writePlan(task.worktree, fileA, revisedContent);
    writeFileSync(join(task.worktree, fileA), revisedContent);
    git(task.worktree, ['add', '--', fileA]);
    git(task.worktree, ['commit', '-m', 'Worker updates Storybook entry']);
    const secondSource = h.head(task.branch);
    const second = await runTrain(h, job, { sameRedactedFingerprint: true });

    expect(first[0]!.rebaseConflict?.targetHead).toBe(firstTarget);
    expect(second[0]!.rebaseConflict).toEqual({ targetHead: firstTarget, workerCommit: secondSource, paths: [fileA] });
    expect(secondSource).not.toBe(firstSource);
    for (const attempt of [1, 2])
      expect(h.store.record({ taskId: task.id, attempt })?.firstFailure).toBe(REPEATED_REDACTED_FINGERPRINT);
    expect(h.store.task(task.id).currentAttempt).toBe(3);

    const newBase = h.head('main');
    git(task.worktree, ['reset', '--hard', newBase]);
    const revisedLayout = 'worker adds the Storybook layout\n';
    mkdirSync(dirname(join(task.worktree, fileB)), { recursive: true });
    writePlan(task.worktree, fileB, revisedLayout);
    writeFileSync(join(task.worktree, fileB), revisedLayout);
    git(task.worktree, ['add', '--', fileB]);
    git(task.worktree, ['commit', '-m', 'Worker adds Storybook layout']);
    const thirdSource = h.head(task.branch);
    const thirdTarget = advanceMain(h, fileB, 'main Storybook layout reorganization\n');
    const third = await runTrain(h, job, { sameRedactedFingerprint: true });

    expect(third[0]!.rebaseConflict).toEqual({ targetHead: thirdTarget, workerCommit: thirdSource, paths: [fileB] });
    expect(third[0]!.firstFailure?.fingerprint).not.toBeUndefined();
    expect(h.store.record({ taskId: task.id, attempt: 3 })?.firstFailure).toBe(REPEATED_REDACTED_FINGERPRINT);
    expect(h.store.task(task.id).currentAttempt).toBe(4);
    expect(h.store.events(task.id).filter((event) => event.kind === 'manager-event')).toEqual([]);
  } finally {
    h.dispose();
  }
}, 60_000);

test('Only repeated SAME files+integrationhead+workercommit without progress triggers one durable notice across replay/restart', async () => {
  const h = integrationHarness();
  const job = durableJob(h);
  let restartedDb: ReturnType<typeof openDb> | undefined;
  try {
    const files = [
      { path: 'tools/goal/src/storybook-a.ts', content: 'worker Storybook A\n' },
      { path: 'tools/goal/src/storybook-b.ts', content: 'worker Storybook B\n' },
    ];
    const task = h.dispatch(files.map((file) => file.path).join(', '), [], ['true'], 'control-plane');
    installMultiFilePlan(h, task.worktree, files);
    await job.start(task.id);
    await job.drain();
    const source = h.head(task.branch);
    const target = advanceMainFiles(
      h,
      files.map((file) => ({ path: file.path, content: `main reorganizes ${file.content}` })),
    );

    const first = await runTrain(h, job, { sameRedactedFingerprint: true });
    resetWorkerBranch(task.worktree, source);
    const second = await runTrain(h, job, { sameRedactedFingerprint: true });
    expect(first[0]!.rebaseConflict).toEqual({
      targetHead: target,
      workerCommit: source,
      paths: files.map((file) => file.path).sort(),
    });
    expect(second[0]!.rebaseConflict).toEqual(first[0]!.rebaseConflict);
    expect(h.store.task(task.id).currentAttempt).toBe(3);
    expect(h.store.events(task.id).filter((event) => event.kind === 'manager-event')).toEqual([]);

    for (const attempt of [1, 2])
      rewriteStoredOutcome(h, task.id, attempt, (outcome) => {
        const reversed = [...outcome.rebaseConflict!.paths].reverse();
        outcome.rebaseConflict!.paths = [...reversed, reversed[0]!];
      });

    resetWorkerBranch(task.worktree, source);
    const third = await runTrain(h, job, { sameRedactedFingerprint: true });
    const context = third[0]!.rebaseConflict!;
    expect(context.paths).toEqual(files.map((file) => file.path).sort());
    expect(context.targetHead).toBe(target);
    expect(context.workerCommit).toBe(source);
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(h.store.record({ taskId: task.id, attempt: 3 })?.escalation).toBe('spec-conflict');

    const managerEvents = h.store
      .events(task.id)
      .filter((event) => event.kind === 'manager-event')
      .map((event) => JSON.parse(event.body) as { summary: string });
    expect(managerEvents).toHaveLength(1);
    expect(managerEvents[0]!.summary).toContain(`target ${target}`);
    expect(managerEvents[0]!.summary).toContain(`worker ${source}`);
    for (const file of context.paths) expect(managerEvents[0]!.summary).toContain(file);

    job.onGateOutcome(third[0]!);
    restartedDb = openDb(join(h.settings.stateDirectory, 'goal.sqlite'));
    const restartedStore = new WorkerStore(restartedDb);
    const restartedTasks = new WorkerTasks(h.settings, restartedStore);
    const restartedQueue = new SqliteLandingQueue(restartedDb, restartedStore);
    const restartedInbox = new SqliteManagerInbox(restartedDb, h.settings.integration.inboxDirectory);
    const restartedJob = new WorkerJob(restartedTasks, restartedQueue, restartedInbox);
    restartedJob.onGateOutcome(third[0]!);
    expect(restartedStore.events(task.id).filter((event) => event.kind === 'manager-event')).toHaveLength(1);
    expect(restartedInbox.pending(task.brief.manager)).toHaveLength(1);
  } finally {
    restartedDb?.close();
    h.dispose();
  }
}, 60_000);

test('prior unknown records do not cause a false positive', async () => {
  const h = integrationHarness();
  const job = durableJob(h);
  try {
    const file = 'tools/goal/src/storybook-unknown-history.ts';
    const task = await startWorker(h, job, file);
    const source = h.head(task.branch);
    advanceMain(h, file, 'main Storybook history change\n');

    const first = await runTrain(h, job, { sameRedactedFingerprint: true });
    resetWorkerBranch(task.worktree, source);
    const second = await runTrain(h, job, { sameRedactedFingerprint: true });
    expect(second[0]!.rebaseConflict).toEqual(first[0]!.rebaseConflict);
    for (const attempt of [1, 2])
      rewriteStoredOutcome(h, task.id, attempt, (outcome) => {
        delete outcome.rebaseConflict;
      });

    resetWorkerBranch(task.worktree, source);
    await runTrain(h, job, { sameRedactedFingerprint: true });
    expect(h.store.task(task.id).currentAttempt).toBe(4);
    expect(h.store.task(task.id).state).not.toBe('stopped');
    expect(h.store.events(task.id).filter((event) => event.kind === 'manager-event')).toEqual([]);
  } finally {
    h.dispose();
  }
}, 60_000);

test('batch rebases capture the cumulative target after earlier members change it', async () => {
  const h = integrationHarness();
  const job = durableJob(h);
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    const file = 'shared-storybook-entry.ts';
    const firstTask = h.dispatch(file, [], ['true'], 'fixture');
    const secondTask = h.dispatch(file, [], ['true'], 'fixture');
    writePlan(firstTask.worktree, file, 'first worker Storybook entry\n');
    writePlan(secondTask.worktree, file, 'second worker Storybook entry\n');
    installNoProgressWorker(h);
    await job.start(firstTask.id);
    await job.drain();
    await job.start(secondTask.id);
    await job.drain();
    const initialTarget = h.head('dev');
    const source = h.head(secondTask.branch);

    const outcomes = await runTrain(h, job);
    const first = outcomes.find((outcome) => outcome.taskId === firstTask.id);
    const second = outcomes.find((outcome) => outcome.taskId === secondTask.id);

    expect(first?.passed).toBe(true);
    expect(second?.rebaseConflict).toEqual({
      targetHead: h.head('dev'),
      workerCommit: source,
      paths: [file],
    });
    expect(second?.rebaseConflict?.targetHead).not.toBe(initialTarget);
    expect(second?.rebaseConflict?.targetHead).toBe(first?.mergedCommit);
    expect(h.store.task(secondTask.id).currentAttempt).toBe(2);
  } finally {
    h.dispose();
  }
}, 60_000);

test('a stale attempt cannot publish its worker commit', async () => {
  const h = integrationHarness();
  const job = durableJob(h);
  try {
    h.ensureDev();
    const task = await startWorker(h, job, 'stale-storybook-entry.ts', 'fixture');
    const targetBefore = h.head('dev');
    await job.start(task.id);
    await job.drain();
    const newerRequest = h.store.db
      .query('SELECT id FROM landing_queue WHERE task=? AND attempt=2')
      .get(task.id) as { id: number };
    h.queue.acknowledge(newerRequest.id);

    const outcomes = await runTrain(h, job);

    expect(outcomes).toEqual([]);
    expect(h.head('dev')).toBe(targetBefore);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.task(task.id).state).not.toBe('integrated');
    expect(h.store.events(task.id).filter((event) => event.kind === 'gate-outcome')).toEqual([]);
  } finally {
    h.dispose();
  }
}, 60_000);

function installMultiFilePlan(
  h: ReturnType<typeof integrationHarness>,
  worktree: string,
  files: readonly { path: string; content: string }[],
): void {
  const command = h.settings.pools[0]!.command;
  writeFileSync(
    command,
    `#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const plan = JSON.parse(readFileSync('.temp/worker-plan.json', 'utf8'));
let count = 0;
try { count = Number(readFileSync('.temp/worker-attempt-count', 'utf8')); } catch {}
writeFileSync('.temp/worker-attempt-count', String(count + 1));
if (count === 0) {
  for (const file of plan.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
    spawnSync('git', ['add', '--', file.path]);
  }
  spawnSync('git', ['commit', '-qm', 'Complete fixture']);
}
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`,
  );
  writeFileSync(
    join(worktree, '.temp/worker-plan.json'),
    JSON.stringify({ files: files.map((file) => ({ path: file.path, content: file.content })) }),
  );
}

function installNoProgressWorker(h: ReturnType<typeof integrationHarness>): void {
  writeFileSync(
    h.settings.pools[0]!.command,
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const plan = JSON.parse(readFileSync('.temp/worker-plan.json', 'utf8'));
let count = 0;
try { count = Number(readFileSync('.temp/worker-attempt-count', 'utf8')); } catch {}
writeFileSync('.temp/worker-attempt-count', String(count + 1));
if (count === 0) {
  writeFileSync(plan.file, plan.content);
  spawnSync('git', ['add', '--', plan.file]);
  spawnSync('git', ['commit', '-qm', 'Complete fixture']);
}
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`,
  );
}
