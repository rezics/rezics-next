import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { branchHead } from './attempt-progress.ts';
import { beginTypingInputReceipt } from './worker-check-typing-inputs.ts';
import type { LandingRequest } from './contracts.ts';
import { newestWorktreeMtime, WorkerJob } from './job.ts';
import { processIdentity, type ProcessIdentity } from './process.ts';
import { harness, reading, tempDirectory } from './test-support.ts';
import {
  KERNEL_CLIENT_OUTPUT,
  outputTreeDigest,
  restoreOutputTree,
  withKernelClientOutput,
} from '../../../scripts/check-output-tree.ts';
import {
  admitWorkerCheckHostRun,
  recordWorkerCheckTypingInputs,
  settleWorkerCheckHostBudget,
  workerCheckBudgetDirectory,
} from './worker-check-budget.ts';
import type { Attempt, RetryIntent } from './types.ts';

function waitingResumeCli(checkId: string): string {
  const waiting = JSON.stringify({ status: 'waiting', summary: 'check is running', checks: [checkId] });
  return `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
if (process.argv.includes('resume')) {
  writeFileSync(join(root, '.temp/goal/resume-args.json'), JSON.stringify(process.argv));
  writeFileSync(join(root, '.temp/goal/resume-started'), 'yes');
  writeFileSync('result.txt', 'accepted');
  spawnSync('git', ['add', 'result.txt']);
  spawnSync('git', ['commit', '-qm', 'Resume check session']);
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
} else {
  console.log(JSON.stringify({type:'thread.started',thread_id:'wake-session'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(waiting)}}}));
}
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let step = 0; step < 200; step += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for capacity ticket');
}

function poolReading(pool: ReturnType<typeof harness>['settings']['pools'][number], used: number, resetsAt: number) {
  const value = reading(pool, used);
  value.at = value.observedAt = new Date().toISOString();
  value.windows[0]!.minutes = 10080;
  value.windows[0]!.resetsAt = resetsAt;
  return value;
}

async function typingRetryFixture(
  h: ReturnType<typeof harness>,
  options: {
    exited?: boolean;
    kernelOutput?: boolean;
    unknownCustody?: boolean;
    misclassified?: boolean;
    stale?: boolean;
    foreign?: boolean;
    auxiliaryProcesses?: ProcessIdentity[];
  } = {},
) {
  const exited = options.exited ?? false;
  const kernelOutput = options.kernelOutput ?? false;
  if (kernelOutput && !exited) throw new Error('Kernel output fixture models an exited compiler attempt');
  const brief = readFileSync(h.briefFile, 'utf8')
    .replace(/^goal: fixture$/m, 'goal: web')
    .replace(/^kind: implementation$/m, 'kind: interface');
  writeFileSync(h.briefFile, brief);
  const task = h.tasks.dispatch(h.briefFile);
  const ref = { taskId: task.id, attempt: 1 };
  const now = Date.now();
  const workerProcess: ProcessIdentity = { pid: 2_000_000_000, start: '1', boot: 'fixture', group: 2_000_000_000 };
  const endedAt = new Date(now - 5_000).toISOString();
  const stopRequestedAt = new Date(now - 3_000).toISOString();
  const stopSettledAt = new Date(now - 2_000).toISOString();
  h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (number): Attempt => ({
    taskId: task.id,
    attempt: number,
    state: 'pending',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: new Date(now - 10_000).toISOString(),
    endedAt: null,
    process: exited ? null : workerProcess,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, '1.jsonl'),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, '1'),
    auxiliaryProcesses: options.auxiliaryProcesses ?? [],
    session: 'reader-session',
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

  const compiler = kernelOutput
    ? [
        'sh',
        '-c',
        'bun run --cwd services/kernel typecheck --emit-client && bun run --cwd packages/client typecheck',
      ]
    : ['bun', 'run', '--cwd', 'apps/web', 'typecheck'];
  const checkId = randomUUID();
  const physicalRunId = randomUUID();
  const outputRun = `client-output-${physicalRunId}`;
  const worktree = task.worktree;
  if (kernelOutput) {
    mkdirSync(join(worktree, 'services/kernel'), { recursive: true });
    mkdirSync(join(worktree, 'packages/client/src/kernel'), { recursive: true });
    writeFileSync(
      join(worktree, 'services/kernel/package.json'),
      JSON.stringify({ scripts: { typecheck: 'bun scripts/typecheck.ts' } }),
    );
    writeFileSync(
      join(worktree, 'packages/client/package.json'),
      JSON.stringify({ scripts: { typecheck: 'bun check --no-script -p tsconfig.json' } }),
    );
    writeFileSync(join(worktree, 'packages/client/tsconfig.json'), '{"include":["src"]}');
    writeFileSync(join(worktree, 'packages/client/src/index.ts'), 'export const route = "current";\n');
    writeFileSync(join(worktree, 'packages/client/src/kernel/routes.d.ts'), 'export type Route = "old";\n');
  } else {
    mkdirSync(join(worktree, 'apps/web/scripts'), { recursive: true });
    mkdirSync(join(worktree, 'apps/web/src'), { recursive: true });
    writeFileSync(
      join(worktree, 'apps/web/package.json'),
      JSON.stringify({ name: '@rezics/web', scripts: { typecheck: 'bun scripts/typecheck.ts' } }),
    );
    writeFileSync(join(worktree, 'apps/web/tsconfig.json'), '{"include":["src/**/*.ts"]}');
    writeFileSync(join(worktree, 'apps/web/scripts/typecheck.ts'), 'export {};\n');
    writeFileSync(join(worktree, 'apps/web/src/reader.ts'), 'export const mounted = false;\n');
  }

  const budget = workerCheckBudgetDirectory(h.settings.stateDirectory, task.id, ref.attempt);
  const admitted = admitWorkerCheckHostRun({ directory: budget, worktree, limit: 2 });
  if (!admitted.ok || !('stamp' in admitted)) throw new Error('Compiler fixture requires a stamped budget admission');
  const env: NodeJS.ProcessEnv = {
    GOAL_WORKER_CHECK_BUDGET: '2',
    GOAL_WORKER_CHECK_BUDGET_DIR: budget,
    GOAL_WORKER_CHECK_BUDGET_STAMP: admitted.stamp,
    REZICS_TYPING_INPUTS_PHYSICAL: physicalRunId,
    REZICS_TYPING_INPUTS_COMMAND: Buffer.from(JSON.stringify(compiler)).toString('base64'),
    ...(kernelOutput ? { REMOTE_CHECK_HOST: 'fixture-host', REZICS_CHECK_RUN: outputRun } : {}),
  };
  recordWorkerCheckTypingInputs(env, worktree, physicalRunId, compiler);
  const complete = beginTypingInputReceipt(worktree, env, compiler);
  if (!complete) throw new Error('Compiler fixture did not capture its inputs');
  if (kernelOutput) {
    mkdirSync(join(worktree, '.temp/goal/checks'), { recursive: true });
    const artifactStage = process.env.REZICS_CHECK_ARTIFACTS_DIR;
    if (artifactStage) mkdirSync(join(worktree, artifactStage), { recursive: true });
    const sourceSha256 = 'a'.repeat(64);
    const producerExit = await withKernelClientOutput(
      worktree,
      async () => {
        rmSync(join(worktree, KERNEL_CLIENT_OUTPUT.root), { recursive: true, force: true });
        mkdirSync(join(worktree, KERNEL_CLIENT_OUTPUT.root), { recursive: true });
        writeFileSync(join(worktree, KERNEL_CLIENT_OUTPUT.root, 'routes.d.ts'), 'export type Route = "current";\n');
        return 0;
      },
      {
        recognize: () => ({
          outcome: 'admitted',
          runId: outputRun,
          scope: 'fixture.scope',
          supervisor: { pid: 1, started: '1', group: 1 },
        }),
        prepared: (_root, run) => ({ host: 'fixture-host', run, sourceSha256 }),
      },
    );
    if (producerExit !== 0) throw new Error('Kernel client output producer fixture failed');
    const bundle = readFileSync(join(worktree, KERNEL_CLIENT_OUTPUT.transport));
    restoreOutputTree(worktree, bundle, {
      host: 'fixture-host',
      run: outputRun,
      sourceSha256,
      exitCode: 0,
      bundleSha256: outputTreeDigest(bundle),
    });
  }
  complete(1);

  const log = join(h.settings.stateDirectory, `${task.id}.typecheck.log`);
  writeFileSync(
    log,
    kernelOutput
      ? 'packages/client/src/index.ts(1,1): error TS2322: route diagnostic\n'
      : 'apps/web/src/reader.ts(1,1): error TS2322: required optional prop is missing\n',
  );
  settleWorkerCheckHostBudget(env, 1, true, { argv: compiler, log, worktree, physicalRunId });
  if (options.stale) writeFileSync(join(worktree, 'packages/client/src/index.ts'), 'export const route = "changed";\n');

  const checks = join(worktree, '.temp/goal/checks');
  mkdirSync(join(checks, 'results'), { recursive: true });
  const result = {
    id: checkId,
    cwd: worktree,
    argv: compiler,
    ownership: { taskId: options.foreign ? 'foreign-task' : task.id, attempt: ref.attempt },
    status: options.unknownCustody ? 'running' : 'finished',
    ...(options.unknownCustody ? {} : { exitCode: 1 }),
    physicalRunId,
  };
  writeFileSync(join(checks, 'results', `${checkId}.json`), JSON.stringify(result));
  if (!options.unknownCustody) {
    const history = join(checks, 'custody/history');
    mkdirSync(history, { recursive: true });
    writeFileSync(
      join(history, `${checkId}.${physicalRunId}.json`),
      JSON.stringify({
        version: 1,
        id: checkId,
        cwd: worktree,
        physicalRunId,
        status: 'finished',
        remoteExpected: false,
        exitCode: 1,
        terminalProof: { local: true, remote: null, resultKnown: true, observedAt: new Date().toISOString() },
      }),
    );
  }
  h.store.updateTask(ref, (current) => {
    current.state = exited ? 'ready' : 'stopped';
  });
  h.store.updateAttempt(ref, (current) => {
    current.state = exited ? 'exited' : 'stopped';
    current.endedAt = endedAt;
    current.exitCode = 0;
    if (exited) current.failureKind = null;
    current.result = 'Compiler evidence is pending.';
    current.typingEvidencePending = { result: current.result, command: compiler };
    current.checks = [checkId];
    if (!exited)
      current.terminationIntent = {
        operation: 'stop',
        requestedAt: stopRequestedAt,
        state: 'complete',
        processIdentity: 'known',
        process: workerProcess,
        auxiliaryProcesses: options.auxiliaryProcesses ?? [],
        settledAt: stopSettledAt,
      };
  });
  if (exited) {
    const head = branchHead(h.store.task(task.id));
    if (!head) throw new Error('Could not capture the task branch head');
    h.store.event(ref, 'attempt-progress', {
      startHead: head,
      endHead: head,
      uncommitted: false,
      progress: false,
    });
    const amendedBrief = join(h.settings.stateDirectory, `${task.id}-amended.md`);
    writeFileSync(amendedBrief, `${readFileSync(h.briefFile, 'utf8')}\nApply the focused route correction.\n`);
    h.tasks.queueRetry(task.id, { expectedAttempt: ref.attempt, brief: amendedBrief });
  } else {
    h.store.recordExplicitRetry(
      ref,
      (current) => {
        current.state = 'ready';
      },
      { freshSession: true },
    );
    if (options.misclassified)
      h.store.updateRetryIntent(ref, (current) => {
        current.status = 'started';
        current.nextAttempt = ref.attempt;
      });
  }
  return { task: h.store.task(task.id), ref, checkId };
}
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

test('an amended retry reuses a current Kernel client-output failure only after owned custody is terminal', async () => {
  const h = harness();
  try {
    const current = await typingRetryFixture(h, { exited: true, kernelOutput: true });
    const unresolved = await typingRetryFixture(h, { exited: true, kernelOutput: true, unknownCustody: true });
    const stale = await typingRetryFixture(h, { exited: true, kernelOutput: true, stale: true });
    const foreign = await typingRetryFixture(h, { exited: true, kernelOutput: true, foreign: true });
    const landings: LandingRequest[] = [];
    const job = new WorkerJob(h.tasks, { enqueue: (request) => landings.push(request) }, { deliver() {} });

    job.resumePendingRetries();
    await job.drain();

    expect(h.store.task(current.task.id).currentAttempt).toBe(2);
    expect(h.store.retryIntent(current.ref)).toMatchObject({ status: 'started', nextAttempt: 2 });
    expect(h.store.attempt(current.ref).state).toBe('superseded');
    expect(h.store.attempt({ taskId: current.task.id, attempt: 2 }).state).toBe('exited');
    expect(
      h.store.events(current.task.id).some((event) => event.kind === 'worker-run-started' && event.attempt === 2),
    ).toBe(true);

    for (const retained of [unresolved, stale, foreign]) {
      expect(h.store.task(retained.task.id).currentAttempt).toBe(1);
      expect(h.store.retryIntent(retained.ref)?.status).toBe('pending');
      expect(h.store.attempt(retained.ref).state).toBe('exited');
      expect(
        h.store.events(retained.task.id).some((event) => event.kind === 'worker-run-started' && event.attempt > 1),
      ).toBe(false);
    }
    expect(landings).toHaveLength(1);
  } finally {
    await h.disposeAsync();
  }
}, 30_000);

test('an explicit stopped-to-ready retry supersedes current terminal compiler failure only after physical check custody settles', async () => {
  const h = harness();
  try {
    const parked = await typingRetryFixture(h, { unknownCustody: true });
    const recoverable = await typingRetryFixture(h, { misclassified: true });
    const liveAuxiliaryIdentity = processIdentity();
    if (!liveAuxiliaryIdentity) throw new Error('Could not identify the test process');
    const liveAuxiliary = await typingRetryFixture(h, { auxiliaryProcesses: [liveAuxiliaryIdentity] });
    const landings: LandingRequest[] = [];
    const job = new WorkerJob(h.tasks, { enqueue: (request) => landings.push(request) }, { deliver() {} });

    job.resumePendingRetries();
    await job.drain();

    expect(h.store.task(parked.task.id).currentAttempt).toBe(1);
    expect(h.store.task(parked.task.id).state).toBe('ready');
    expect(h.store.retryIntent(parked.ref)?.status).toBe('pending');
    expect(h.store.retryIntent(parked.ref)?.nextAttempt).toBeUndefined();
    expect(h.store.attempt(parked.ref).typingEvidencePending).toBeDefined();
    expect(
      h.store.events(parked.task.id).some((event) => event.kind === 'worker-run-started' && event.attempt > 1),
    ).toBe(false);

    expect(h.store.task(recoverable.task.id).currentAttempt).toBe(2);
    expect(h.store.retryIntent(recoverable.ref)).toMatchObject({ status: 'started', nextAttempt: 2 });
    expect(h.store.attempt(recoverable.ref).state).toBe('superseded');
    expect(h.store.attempt({ taskId: recoverable.task.id, attempt: 2 }).state).toBe('exited');
    expect(h.store.attempt({ taskId: recoverable.task.id, attempt: 2 }).typingEvidencePending).toBeUndefined();
    expect(h.store.task(liveAuxiliary.task.id).currentAttempt).toBe(1);
    expect(h.store.retryIntent(liveAuxiliary.ref)?.status).toBe('pending');
    expect(h.store.attempt(liveAuxiliary.ref).state).toBe('stopped');
    job.resumePendingRetries();
    await job.drain();
    expect(
      h.store.events(parked.task.id, parked.ref.attempt).filter((event) => event.kind === 'typing-retry-unreconciled'),
    ).toHaveLength(1);
    expect(landings).toHaveLength(1);
  } finally {
    await h.disposeAsync();
  }
}, 30_000);

test('retry supply observation uses the current routed allowance admission', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const intent = { taskId: task.id, attempt: 1, status: 'pending', options: {} } satisfies RetryIntent;
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const observe = (used: number) =>
      Object.defineProperty(h.tasks, 'reader', {
        value: (pool: (typeof h.settings.pools)[number]) => reading(pool, used),
      });
    observe(0);
    expect(job.hasRunnableRetrySupply(h.store.task(task.id), intent)).toBe(true);
    observe(100);
    expect(job.hasRunnableRetrySupply(h.store.task(task.id), intent)).toBe(false);
  } finally {
    await h.disposeAsync();
  }
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
    const activeAttempt = active.store.attempt({ taskId: task.id, attempt: 1 });
    expect(activeAttempt.state).toBe('exited');
    expect(activeAttempt.failureKind ?? null).toBeNull();
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

test('a queued check wake rechecks its original pool and resumes the same session after its allowance window resets', async () => {
  const checkId = randomUUID();
  const h = harness(waitingResumeCli(checkId));
  const capacityFile = join(h.settings.stateDirectory, 'capacity.json');
  let recovery: Promise<void> | undefined;
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8')) as {
      pools: typeof h.settings.pools;
    };
    local.pools[0]!.policy = { ...local.pools[0]!.policy, allowUnknown: false, maxBurnPerHour: 0.6, maxConcurrent: 1 };
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const policy = structuredClone(h.settings.policy!);
    policy.capacity.pollIntervalMs = 5;
    h.settings.policy = policy;

    let used = 50;
    let resetsAt = Date.now() + 8 * 60 * 60_000;
    let occupied = false;
    Object.defineProperty(h.tasks, 'reader', {
      value: (pool: (typeof h.settings.pools)[number]) => poolReading(pool, used, resetsAt),
    });
    Object.defineProperty(h.store, 'runningAttemptsByPool', {
      value: () => (occupied ? { [h.settings.pools[0]!.name]: 1 } : {}),
    });
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    await job.drain();
    const ref = { taskId: task.id, attempt: 1 };
    const original = h.store.attempt(ref);
    expect(original.state).toBe('waiting');
    occupied = true;

    const results = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, `${checkId}.json`), JSON.stringify({ status: 'finished', exitStatus: 0 }));
    writeFileSync(capacityFile, JSON.stringify({ maxWorkers: 0, minAvailableMiB: 0 }));
    recovery = job.recoverOrphans();
    const queue = join(h.settings.stateDirectory, 'capacity-queue');
    await waitFor(() => existsSync(queue) && readdirSync(queue).some((name) => name.includes(task.id)));

    local.pools.push({
      ...local.pools[0]!,
      name: 'alternate',
      allowanceKey: 'alternate',
      configDirectory: '/fixture/alternate',
    });
    writeFileSync(h.settings.localFile, JSON.stringify(local));

    const previous = poolReading(h.settings.pools[0]!, 50, resetsAt);
    previous.at = previous.observedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    writeFileSync(
      join(h.settings.stateDirectory, 'pool-readings.json'),
      JSON.stringify({ version: 1, readings: [previous] }),
    );
    writeFileSync(capacityFile, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    await recovery;
    recovery = undefined;
    expect(h.store.attempt(ref)).toMatchObject({
      state: 'waiting',
      pool: original.pool,
      session: original.session,
      driver: null,
    });
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(existsSync(join(task.worktree, '.temp/goal/resume-started'))).toBe(false);
    expect(readdirSync(queue)).toHaveLength(0);

    occupied = false;
    // Codex integer readings carry one percentage point of rounding uncertainty. Keep a fractional increase so this
    // fixture still proves a burn-rate violation under the provider's current evidence model.
    used = 51.1;
    recovery = job.recoverOrphans();
    await recovery;
    recovery = undefined;
    expect(h.store.attempt(ref)).toMatchObject({ state: 'waiting', pool: original.pool, session: original.session });
    expect(existsSync(join(task.worktree, '.temp/goal/resume-started'))).toBe(false);

    resetsAt += 7 * 24 * 60 * 60_000;
    recovery = job.recoverOrphans();
    await recovery;
    recovery = undefined;
    const args = JSON.parse(readFileSync(join(task.worktree, '.temp/goal/resume-args.json'), 'utf8')) as string[];
    expect(args).toContain(original.session!);
    expect(h.store.attempt(ref).state).toBe('exited');
    expect(h.store.task(task.id).currentAttempt).toBe(1);
  } finally {
    if (recovery) {
      writeFileSync(capacityFile, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
      await recovery;
    }
    await h.disposeAsync();
  }
}, 30_000);
