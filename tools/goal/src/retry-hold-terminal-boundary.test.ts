import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { openDb } from './db.ts';
import { WorkerJob } from './job.ts';
import { git } from './merge.ts';
import { harness, integrationHarness, markdown } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';

async function holdAndReleaseAfterDependencyReturns(taskState: 'landing' | 'running'): Promise<void> {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const dependency = h.dispatch('dependency.txt');
    await h.start(dependency);
    await h.train();
    expect(h.store.task(dependency.id).state).toBe('integrated');

    const target = h.dispatch('target.txt', [dependency.id]);
    await h.start(target);
    const ref = { taskId: target.id, attempt: 1 };
    const firstAttempt = h.store.attempt(ref);
    expect(h.store.task(target.id).state).toBe('landing');
    expect(firstAttempt.state).toBe('exited');
    expect(firstAttempt.session).toBe('fixture-session');
    const originalBranchHead = git(target.worktree, 'rev-parse', 'HEAD');

    // A promotion failure can move an integrated dependency back to landing while its dependent's retry is pending.
    h.store.applyPromotionFailure(dependency.id, []);
    expect(h.tasks.dependenciesMet(h.store.task(target.id))).toBe(false);
    writeFileSync(
      join(dependency.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: 'dependency.txt', content: 'dependency settled again\n' }),
    );
    await h.start(h.store.task(dependency.id));
    expect(h.store.task(dependency.id).currentAttempt).toBe(2);
    expect(h.store.task(dependency.id).state).toBe('landing');

    if (taskState === 'running')
      h.store.updateTask(ref, (task) => {
        task.state = 'running';
      });
    h.tasks.queueRetry(target.id, { evidence: firstAttempt.evidencePath, escalation: 'environment' });
    expect(h.store.retryIntent(ref)).toMatchObject({
      status: 'pending',
      options: { evidence: firstAttempt.evidencePath, escalation: 'environment' },
    });

    // The host takes the persisted retry through retryTask. The exhausted task attempt is held without changing its
    // session, evidence, branch work, or retry intent while the dependency remains unintegrated.
    await h.job.recoverOrphans();
    await h.job.drain();
    let held = h.store.task(target.id);
    expect(held.state).toBe('held');
    expect(held.currentAttempt).toBe(1);
    expect(held.brief.after).toEqual([dependency.id]);
    expect(h.store.attempt(ref)).toMatchObject({ state: 'exited', session: firstAttempt.session });
    expect(h.store.retryIntent(ref)).toMatchObject({
      status: 'pending',
      options: { evidence: firstAttempt.evidencePath, escalation: 'environment' },
    });
    expect(h.store.retryIntent(ref)?.nextAttempt).toBeUndefined();
    const heldBriefPath = h.store.task(target.id).briefPath;
    if (!heldBriefPath) throw new Error('held retry lost its brief path');
    expect(readFile(heldBriefPath)).toContain(dependency.id);
    expect(git(target.worktree, 'rev-parse', 'HEAD')).toBe(originalBranchHead);
    expect(h.store.attempts(target.id)).toHaveLength(1);
    expect(backgroundErrors(h.inbox)).toHaveLength(0);

    // Repeated host recovery leaves this generation held. Its prior landing row remains available to the real train,
    // which fences and acknowledges it without delivering an outcome over the held retry.
    await h.job.recoverOrphans();
    await h.job.drain();
    expect(h.store.task(target.id).state).toBe('held');
    expect(h.store.task(target.id).currentAttempt).toBe(1);
    expect(h.store.retryIntent(ref)?.status).toBe('pending');
    const beforeTrain = landingRow(h, target.id, 1);
    expect(beforeTrain?.delivered).toBe(0);
    expect(beforeTrain?.outcome).toBeNull();

    await h.train();
    const afterTrain = landingRow(h, target.id, 1);
    expect(afterTrain?.delivered).toBe(1);
    expect(afterTrain?.outcome).toBeNull();
    expect(h.outcomes.some((outcome) => outcome.taskId === target.id && outcome.attempt === 1)).toBe(false);
    expect(landingRow(h, dependency.id, 2)?.delivered).toBe(1);
    const dependencyRetryOutcome = h.outcomes.find(
      (outcome) => outcome.taskId === dependency.id && outcome.attempt === 2,
    );
    expect(dependencyRetryOutcome).toMatchObject({ passed: true, stage: 'merge' });
    expect(h.store.task(dependency.id).state).toBe('integrated');

    const resumed = h.store.task(target.id);
    const integratedBase = h.store.task(dependency.id).integratedCommit;
    if (!integratedBase) throw new Error('dependency integration did not record its verified base');
    expect(resumed.currentAttempt).toBe(2);
    const resumedAttempt = h.store.attempt({ taskId: target.id, attempt: 2 });
    expect(resumed.state).toMatch(/^(landing|integrated|merged)$/);
    expect(resumed.base).toBe(integratedBase);
    expect(existsSync(join(resumed.worktree, 'dependency.txt'))).toBe(true);
    expect(git(resumed.worktree, 'log', '--format=%s')).toContain('Complete fixture');
    expect(resumedAttempt.session).toBe(firstAttempt.session);
    const runStarted = h.store.events(target.id, 2).find((event) => event.kind === 'worker-run-started');
    expect(runStarted && JSON.parse(runStarted.body).resuming).toBe(true);

    // Host recovery completes the retained intent once, and another sweep cannot start a third worker.
    await h.job.recoverOrphans();
    await h.job.drain();
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'started', nextAttempt: 2 });
    await h.job.recoverOrphans();
    await h.job.drain();
    expect(h.store.task(target.id).currentAttempt).toBe(2);
    expect(h.store.attempts(target.id)).toHaveLength(2);
    expect(backgroundErrors(h.inbox)).toHaveLength(0);
  } finally {
    h.dispose();
  }
}

function readFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function landingRow(
  h: ReturnType<typeof integrationHarness>,
  taskId: string,
  attempt: number,
): { delivered: number; outcome: string | null } | null {
  return h.store.db
    .query('SELECT delivered, outcome FROM landing_queue WHERE task=? AND attempt=?')
    .get(taskId, attempt) as { delivered: number; outcome: string | null } | null;
}

function backgroundErrors(events: ReturnType<typeof integrationHarness>['inbox']) {
  return events.filter((event) => event.summary.includes('Control-plane background work failed'));
}

test('A landing task whose current attempt exited can be held for unmet dependencies and releases once without a background hold error', async () => {
  await holdAndReleaseAfterDependencyReturns('landing');
});

test('A running task whose current attempt exited can be held equivalently; truly running and stale attempts remain refused', async () => {
  await holdAndReleaseAfterDependencyReturns('running');
});

test('a genuinely running attempt, stale references, identity changes, and unrelated terminal states remain refused', async () => {
  const h = harness(`#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
while (!existsSync('.temp/goal/release-worker')) await new Promise(resolve => setTimeout(resolve, 5));
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`);
  const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  let worker: Awaited<ReturnType<typeof h.tasks.retry>> | undefined;
  try {
    const task = h.tasks.dispatch(h.briefFile);
    worker = await h.tasks.retry(task.id);
    const ref = worker.attempt;
    expect(h.store.task(task.id).state).toBe('running');
    expect(h.store.attempt(ref).state).toBe('running');
    expect(() =>
      h.store.updateHeldRetryTask(ref, (current) => {
        current.state = 'held';
      }),
    ).toThrow('task cannot be held for retry');
    expect(() =>
      h.store.updateHeldRetryTask({ taskId: task.id, attempt: 0 }, (current) => {
        current.state = 'held';
      }),
    ).toThrow('task cannot be held for retry');
    expect(h.store.task(task.id).state).toBe('running');

    const release = join(task.worktree, '.temp/goal/release-worker');
    mkdirSync(join(task.worktree, '.temp/goal'), { recursive: true });
    writeFileSync(release, 'go');
    await job.follow(worker);
    expect(h.store.task(task.id).state).toBe('landing');
    expect(h.store.attempt(ref).state).toBe('exited');

    expect(() =>
      h.store.updateHeldRetryTask(ref, (current) => {
        current.currentAttempt++;
      }),
    ).toThrow('task identity cannot be updated');
    expect(h.store.task(task.id).currentAttempt).toBe(1);

    h.store.updateTask(ref, (current) => {
      current.state = 'integrated';
    });
    expect(() => h.store.updateHeldRetryTask(ref, () => {})).toThrow('task cannot be held for retry');
    for (const state of ['merged', 'cancelled'] as const) {
      h.store.updateTask(ref, (current) => {
        current.state = state;
      });
      expect(() => h.store.updateHeldRetryTask(ref, () => {})).toThrow('task cannot be held for retry');
    }
    h.store.updateTask(ref, (current) => {
      current.state = 'landing';
    });
    h.store.updateAttempt(ref, (current) => {
      current.state = 'stopped';
    });
    expect(() => h.store.updateHeldRetryTask(ref, () => {})).toThrow('task cannot be held for retry');
  } finally {
    if (worker) {
      const release = join(h.store.task(worker.attempt.taskId).worktree, '.temp/goal/release-worker');
      mkdirSync(join(h.store.task(worker.attempt.taskId).worktree, '.temp/goal'), { recursive: true });
      writeFileSync(release, 'go');
      if (h.store.attempt(worker.attempt).state === 'running') await job.follow(worker);
    }
    h.dispose();
  }
});

test('CLI reshape of a held task preserves every attempt and retry-intent state without starting a worker', async () => {
  const h = harness();
  // Seed historical states through another connection, as a controller restart would observe them. Direct writes on
  // the store's own connection bypass its write methods and do not advance SQLite's data_version for its read cache.
  const fixtureDb = openDb(join(h.settings.stateDirectory, 'goal.sqlite'));
  try {
    const dependency = h.tasks.dispatch(h.briefFile);
    const task = h.tasks.dispatch(h.briefFile);
    const worker = await h.tasks.retry(task.id);
    await worker.exited;
    const ref = worker.attempt;
    const originalAttempt = h.store.attempt(ref);
    const originalHistory = h.store.events(task.id).map(({ sequence, kind, body }) => ({ sequence, kind, body }));
    h.store.updateTask(ref, (current) => {
      current.state = 'held';
      current.brief.after = [dependency.id];
    });

    const attemptStates = ['waiting', 'stopped', 'exited', 'superseded', 'pending', 'running', 'cancelled'] as const;
    const intentStates = ['pending', 'started', 'completed', undefined] as const;
    let reshape = 0;
    for (const attemptState of attemptStates) {
      for (const intentState of intentStates) {
        const attempt = { ...originalAttempt, state: attemptState };
        fixtureDb
          .query('UPDATE worker_attempts SET body=? WHERE task_id=? AND attempt=?')
          .run(JSON.stringify(attempt), ref.taskId, ref.attempt);
        fixtureDb.query('DELETE FROM worker_retry_intents WHERE task_id=? AND attempt=?').run(ref.taskId, ref.attempt);
        if (intentState) {
          fixtureDb.query('INSERT INTO worker_retry_intents VALUES (?,?,?)').run(
            ref.taskId,
            ref.attempt,
            JSON.stringify({
              ...ref,
              options: { evidence: 'preserved-evidence', escalation: 'environment' },
              status: intentState,
              nextAttempt: 8,
            }),
          );
        }

        const amendedText = `${markdown
          .replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`)
          .trimEnd()}\n\nAmended generation ${reshape++}.\n`;
        expect(amendedText.match(/^after:/gm)).toHaveLength(1);
        expect(parseBrief(amendedText, readRiskOwnership(h.settings.riskAreasFile)).after).toEqual([dependency.id]);
        const amendedFile = join(h.root, `.temp/goal/reshape-${reshape}.md`);
        writeFileSync(amendedFile, amendedText);
        const result = await runWorkerCommand('retry', [task.id, '--brief', amendedFile], {
          settings: h.settings,
          store: h.store,
          tasks: h.tasks,
          env: {},
          print() {},
        });

        const updated = h.store.task(task.id);
        expect(result).toBe(0);
        expect(updated).toMatchObject({
          id: task.id,
          state: 'held',
          currentAttempt: ref.attempt,
          branch: task.branch,
          worktree: task.worktree,
          base: task.base,
          brief: { markdown: amendedText, after: [dependency.id] },
        });
        expect(h.store.attempt(ref).state).toBe(attemptState);
        expect(h.store.attempt(ref)).toMatchObject({
          session: originalAttempt.session,
          evidencePath: originalAttempt.evidencePath,
          logPath: originalAttempt.logPath,
        });
        expect(h.store.attempts(task.id)).toHaveLength(1);
        expect(h.store.events(task.id).map(({ sequence, kind, body }) => ({ sequence, kind, body }))).toEqual(
          originalHistory,
        );
        expect(h.store.task(task.id).briefPath).toContain('-queued-');
        const staleRequest = { ...ref, branch: task.branch ?? '' };
        const staleOutcome = { ...ref, stage: 'merge' as const };
        expect(() => h.store.assertCurrent(staleRequest)).toThrow();
        expect(() => h.store.assertCurrent(staleOutcome)).toThrow();
        if (attemptState === 'pending' || attemptState === 'waiting')
          expect(() => h.store.assertCurrent(ref)).toThrow();

        const intent = h.store.retryIntent(ref) as
          | { status: string; options?: { evidence?: string; escalation?: string }; nextAttempt?: number }
          | undefined;
        if (intentState === 'pending' || intentState === 'started') {
          expect(intent).toMatchObject({
            status: 'pending',
            options: { evidence: 'preserved-evidence', escalation: 'environment' },
          });
          expect(intent?.nextAttempt).toBeUndefined();
        } else {
          expect(intent?.status).toBe(intentState);
          if (intentState === 'completed') expect(intent?.nextAttempt).toBe(8);
        }
      }
    }

    const sameBrief = join(h.root, '.temp/goal/reshape-same.md');
    writeFileSync(sameBrief, h.store.task(task.id).brief.markdown);
    const before = h.store.attempts(task.id);
    const output: string[] = [];
    expect(
      await runWorkerCommand('retry', [task.id, '--brief', sameBrief], {
        settings: h.settings,
        store: h.store,
        tasks: h.tasks,
        env: {},
        print: (line) => output.push(line),
      }),
    ).toBe(0);
    expect(output).toContain('The contract is unchanged.');
    expect(h.store.attempts(task.id)).toEqual(before);

    const waiting = { ...h.store.attempt(ref), state: 'waiting' as const, checks: ['check-a'] };
    fixtureDb
      .query('UPDATE worker_attempts SET body=? WHERE task_id=? AND attempt=?')
      .run(JSON.stringify(waiting), ref.taskId, ref.attempt);
    const results = join(task.worktree, '.temp/goal/checks/results');
    mkdirSync(results, { recursive: true });
    writeFileSync(join(results, 'check-a.json'), JSON.stringify({ status: 'finished', exitStatus: 0 }));
    const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await host.recoverOrphans();
    await host.drain();
    expect(h.store.task(task.id).state).toBe('held');
    expect(h.store.attempt(ref).state).toBe('waiting');
    expect(h.store.attempts(task.id)).toHaveLength(1);
  } finally {
    fixtureDb.close();
    h.dispose();
  }
});

test('a live held attempt keeps ownership through reshape and releases once on the amended dependency base without resuming its old prompt', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const dependency = h.dispatch('dependency.txt');
    await h.start(dependency);
    await h.train();
    expect(h.store.task(dependency.id).state).toBe('integrated');

    h.store.applyPromotionFailure(dependency.id, []);
    writeFileSync(
      join(dependency.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: 'dependency.txt', content: 'dependency settled again\n' }),
    );
    await h.start(h.store.task(dependency.id));
    expect(h.store.task(dependency.id).state).toBe('landing');

    const target = h.dispatch('target.txt');
    writeFileSync(
      h.settings.pools[0]!.command,
      `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const plan = JSON.parse(readFileSync('.temp/worker-plan.json', 'utf8'));
const first = process.env.GOAL_ATTEMPT === '1';
if (first) {
  console.log(JSON.stringify({type:'thread.started',thread_id:'discarded-session'}));
  while (!existsSync('.temp/goal/release-worker')) await new Promise(resolve => setTimeout(resolve, 5));
} else {
  if (!readFileSync('dependency.txt', 'utf8').includes('dependency settled again')) process.exit(3);
  console.log(JSON.stringify({type:'thread.started',thread_id:'amended-session'}));
}
writeFileSync(plan.file, first ? 'old-contract-result\\n' : 'amended-contract-result\\n');
spawnSync('git', ['add', '--', plan.file]);
spawnSync('git', ['commit', '-qm', first ? 'Complete old fixture' : 'Complete amended fixture']);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`,
    );

    const worker = await h.tasks.retry(target.id);
    const following = h.job.follow(worker);
    const ref = worker.attempt;
    h.store.updateTask(ref, (current) => {
      current.state = 'held';
    });
    const amendedText = target.brief.markdown
      .replace('after: []', `after: [${dependency.id}]`)
      .replace(
        'Write the requested result and commit it.',
        'Use the integrated dependency before completing this task.',
      )
      .concat('\nAmended while the old worker is active.\n');
    expect(amendedText.match(/^after:/gm)).toHaveLength(1);
    expect(parseBrief(amendedText, readRiskOwnership(h.settings.riskAreasFile)).after).toEqual([dependency.id]);
    const amendedFile = join(h.settings.stateDirectory, 'amended-live-held.md');
    writeFileSync(amendedFile, amendedText);
    expect(
      await runWorkerCommand('retry', [target.id, '--brief', amendedFile], {
        settings: h.settings,
        store: h.store,
        tasks: h.tasks,
        env: {},
        print() {},
      }),
    ).toBe(0);
    expect(h.store.task(target.id)).toMatchObject({
      state: 'held',
      currentAttempt: 1,
      brief: { markdown: amendedText },
    });
    expect(h.store.attempt(ref).state).toBe('running');
    expect(h.store.attempts(target.id)).toHaveLength(1);
    expect(h.store.retryIntent(ref)).toBeUndefined();

    await h.job.recoverOrphans();
    await h.job.drain();
    expect(h.store.task(target.id).state).toBe('held');
    expect(h.store.attempt(ref).state).toBe('running');
    expect(h.store.attempts(target.id)).toHaveLength(1);
    expect(backgroundErrors(h.inbox)).toHaveLength(0);

    // The dependency can integrate while the held worker is still live, but its release cannot start a replacement.
    await h.train();
    expect(h.store.task(dependency.id).state).toBe('integrated');
    expect(h.store.task(target.id).state).toBe('held');
    expect(h.store.attempt(ref).state).toBe('running');
    expect(h.store.attempts(target.id)).toHaveLength(1);
    expect(backgroundErrors(h.inbox)).toHaveLength(0);

    const release = join(target.worktree, '.temp/goal/release-worker');
    mkdirSync(join(target.worktree, '.temp/goal'), { recursive: true });
    writeFileSync(release, 'go');
    await following;
    await h.job.drain();
    expect(h.store.task(target.id).state).toBe('held');
    expect(h.store.attempt(ref).state).toBe('exited');
    expect(h.store.events(target.id, 1).some((event) => event.kind === 'landing-requested')).toBe(false);

    const integratedDependency = h.store.task(dependency.id).integratedCommit;
    if (!integratedDependency) throw new Error('dependency retry did not record its integrated source commit');
    await h.job.recoverOrphans();
    await h.job.drain();
    expect(h.store.task(target.id)).toMatchObject({ state: 'landing', currentAttempt: 2, base: integratedDependency });
    expect(existsSync(join(target.worktree, 'dependency.txt'))).toBe(true);
    expect(readFileSync(join(target.worktree, 'dependency.txt'), 'utf8')).toContain('dependency settled again');
    expect(h.store.attempt({ taskId: target.id, attempt: 2 }).session).toBe('amended-session');
    const runStarted = h.store.events(target.id, 2).find((event) => event.kind === 'worker-run-started');
    expect(runStarted && JSON.parse(runStarted.body).resuming).toBe(false);

    await h.job.recoverOrphans();
    await h.job.drain();
    expect(h.store.retryIntent(ref)).toBeUndefined();
    expect(h.store.attempts(target.id)).toHaveLength(2);
    await h.job.recoverOrphans();
    await h.job.drain();
    expect(h.store.attempts(target.id)).toHaveLength(2);
    await h.train();
    expect(h.store.task(target.id).state).toBe('integrated');
    expect(backgroundErrors(h.inbox)).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test('a dependency-held task with no old writer releases once through the real train and host', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const dependency = h.dispatch('dependency.txt');
    const target = h.dispatch('target.txt', [dependency.id]);
    expect(h.store.task(target.id)).toMatchObject({ state: 'held', currentAttempt: 0 });

    await h.start(dependency);
    await h.train();
    const integratedBase = h.store.task(dependency.id).integratedCommit;
    expect(integratedBase).toBeString();
    expect(h.store.task(target.id)).toMatchObject({ currentAttempt: 1, base: integratedBase });
    expect(h.store.task(target.id).state).toMatch(/^(landing|integrated|merged)$/);
    expect(readFileSync(join(target.worktree, 'dependency.txt'), 'utf8')).toBe('dependency.txt');

    await h.job.recoverOrphans();
    await h.job.drain();
    expect(h.store.attempts(target.id)).toHaveLength(1);
    expect(backgroundErrors(h.inbox)).toHaveLength(0);
    expect(() => h.store.assertCurrent({ taskId: target.id, attempt: 0 })).toThrow();
  } finally {
    h.dispose();
  }
});

test('a terminal held amendment joins capacity without its lease and honors a newer dependency contract', async () => {
  const h = harness();
  const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  const capacity = join(h.settings.stateDirectory, 'capacity.json');
  let starting: Promise<void> | undefined;
  try {
    const dependency = h.tasks.dispatch(h.briefFile);
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id);
    const ref = { taskId: task.id, attempt: 1 };
    expect(h.store.attempt(ref).state).toBe('exited');
    h.store.updateTask(ref, (current) => {
      current.state = 'held';
      current.brief.after = [dependency.id];
    });
    const branchHead = git(task.worktree, 'rev-parse', 'HEAD');
    const amended = join(h.settings.stateDirectory, 'capacity-amended.md');
    const readyText = `${markdown}\nReady after removing the dependency.\n`;
    writeFileSync(amended, readyText);
    writeFileSync(capacity, JSON.stringify({ maxWorkers: 0 }));

    starting = job.start(task.id, { brief: amended });
    const queue = join(h.settings.stateDirectory, 'capacity-queue');
    const deadline = Date.now() + 5_000;
    while (!existsSync(queue) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(queue)).toBe(true);
    expect(h.store.task(task.id)).toMatchObject({ state: 'ready', currentAttempt: 1, brief: { markdown: readyText } });
    expect(h.store.attempts(task.id)).toHaveLength(1);
    expect(git(task.worktree, 'rev-parse', 'HEAD')).toBe(branchHead);

    const heldText = markdown
      .replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`)
      .concat('\nWait for the dependency again.\n');
    writeFileSync(amended, heldText);
    await job.start(task.id, { brief: amended });
    expect(h.store.task(task.id)).toMatchObject({ state: 'held', currentAttempt: 1, brief: { markdown: heldText } });
    writeFileSync(capacity, JSON.stringify({ maxWorkers: 1 }));
    await starting;
    expect(h.store.task(task.id)).toMatchObject({ state: 'held', currentAttempt: 1, brief: { markdown: heldText } });
    expect(h.store.attempts(task.id)).toHaveLength(1);

    writeFileSync(amended, `${readyText}\nStart the amended contract now.\n`);
    await job.start(task.id, { brief: amended });
    expect(h.store.task(task.id)).toMatchObject({ state: 'landing', currentAttempt: 2, brief: { after: [] } });
    const runStarted = h.store.events(task.id, 2).find((event) => event.kind === 'worker-run-started');
    expect(runStarted && JSON.parse(runStarted.body).resuming).toBe(false);
  } finally {
    writeFileSync(capacity, JSON.stringify({ maxWorkers: 1 }));
    await starting?.catch(() => {});
    await job.drain();
    h.dispose();
  }
}, 30_000);

test('CLI removal of the last dependency retains a host retry without starting an attempt during reshape', async () => {
  const h = harness();
  const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  try {
    const dependency = h.tasks.dispatch(h.briefFile);
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id);
    const ref = { taskId: task.id, attempt: 1 };
    h.store.updateTask(ref, (current) => {
      current.state = 'held';
      current.brief.after = [dependency.id];
    });
    const amended = join(h.settings.stateDirectory, 'last-dependency-removed.md');
    const amendedText = `${markdown}\nRun without the discarded dependency.\n`;
    writeFileSync(amended, amendedText);
    expect(
      await runWorkerCommand('retry', [task.id, '--brief', amended], {
        settings: h.settings,
        store: h.store,
        tasks: h.tasks,
        env: {},
        print() {},
      }),
    ).toBe(0);
    expect(h.store.task(task.id)).toMatchObject({
      state: 'held',
      currentAttempt: 1,
      brief: { after: [], markdown: amendedText },
    });
    expect(h.store.attempts(task.id)).toHaveLength(1);
    expect(h.store.retryIntent(ref)?.status).toBe('pending');

    await job.recoverOrphans();
    await job.drain();
    expect(h.store.task(task.id)).toMatchObject({ state: 'landing', currentAttempt: 2 });
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'started', nextAttempt: 2 });
    const runStarted = h.store.events(task.id, 2).find((event) => event.kind === 'worker-run-started');
    expect(runStarted && JSON.parse(runStarted.body).resuming).toBe(false);
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.attempts(task.id)).toHaveLength(2);
  } finally {
    h.dispose();
  }
});
