import { expect, spyOn, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagerEvent } from './contracts.ts';
import { makeRecord, readMeasurement } from './records.ts';
import { WorkerJob } from './job.ts';
import { git } from './tasks.ts';
import { blockerFingerprint, toolRetryDelay } from './attempt-progress.ts';
import { devVerificationState } from './dev-verifier.ts';
import { listOpenToolIncidents } from './tool-incidents.ts';
import { brief, harness } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';

const failingCommand = ['bun', 'test', 'tools/goal/src/failure.test.ts'];
const errorLine = 'ENOSPC: no space left on device on host b';

function failAttempt(
  h: ReturnType<typeof harness>,
  taskId: string,
  number: number,
  options: { commandRan?: boolean; error?: string; commit?: boolean } = {},
): void {
  const ref = { taskId, attempt: number };
  const error = options.error ?? errorLine;
  if (options.commit) {
    const worktree = h.store.task(taskId).worktree;
    writeFileSync(join(worktree, 'result.txt'), `progress in attempt ${number}\n`);
    git(worktree, ['add', 'result.txt']);
    git(worktree, ['commit', '-qm', `Progress in attempt ${number}`]);
  }
  const attempt = h.store.updateAttempt(ref, (current) => {
    current.state = 'exited';
    current.endedAt = new Date().toISOString();
    current.failureKind = 'tool';
    current.failureCommand = failingCommand;
    current.blocker = error;
    current.result = `BLOCKER: tool\n${error}`;
  });
  h.store.updateTask(ref, (task) => {
    task.state = 'running';
  });
  h.store.putRecord(makeRecord(h.store.task(taskId), attempt, readMeasurement(attempt), 'stopped'));
  if (options.commandRan) {
    writeFileSync(
      attempt.logPath,
      `${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', id: 'check', command: failingCommand.join(' ') } })}\n`,
    );
  }
}

const captureAndSucceed = `#!/usr/bin/env bun
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = '.temp/goal-test-prompts';
mkdirSync(directory, { recursive: true });
const number = readdirSync(directory).length + 1;
writeFileSync(join(directory, String(number)), process.argv.at(-1) ?? '');
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

async function withRetryFixture(
  run: (job: WorkerJob, h: ReturnType<typeof harness>, taskId: string, inbox: ManagerEvent[]) => Promise<void>,
  first: { commandRan?: boolean; error?: string; commit?: boolean } = {},
) {
  const h = harness(captureAndSucceed),
    inbox: ManagerEvent[] = [];
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.start(task.id);
    failAttempt(h, task.id, 1, first);
    job.onAttemptExit({ taskId: task.id, attempt: 1 });
    await job.drain();
    await run(job, h, task.id, inbox);
  } finally {
    h.dispose();
  }
}

async function withThreeTaskIncident(
  run: (job: WorkerJob, h: ReturnType<typeof harness>, taskIds: string[], inbox: ManagerEvent[]) => Promise<void>,
): Promise<void> {
  const h = harness(captureAndSucceed),
    inbox: ManagerEvent[] = [];
  try {
    h.settings.toolRetryBackoffMs = [0, 0, 0];
    const taskIds = [1, 2, 3].map(() => h.tasks.dispatch(h.briefFile).id);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    for (const taskId of taskIds) await job.start(taskId);
    for (const [index, taskId] of taskIds.entries()) {
      const task = h.store.task(taskId);
      failAttempt(h, taskId, 1, {
        error: `ENOSPC: no space left on device at ${task.worktree}/cache-${index + 11} errno ${100 + index}`,
      });
      job.onAttemptExit({ taskId, attempt: 1 });
    }
    await job.drain();
    await run(job, h, taskIds, inbox);
  } finally {
    h.dispose();
  }
}

for (const commandRan of [false, true])
  test(`the same tool blocker twice parks the task with one environment event (command ${commandRan ? 'rerun' : 'not rerun'})`, async () => {
    await withRetryFixture(async (job, h, taskId, inbox) => {
      expect(h.store.task(taskId).currentAttempt).toBe(2);
      expect(inbox).toEqual([]);
      failAttempt(h, taskId, 2, { commandRan, commit: true });
      job.onAttemptExit({ taskId, attempt: 2 });
      await job.drain();

      expect(h.store.task(taskId)).toMatchObject({ currentAttempt: 2, state: 'stopped' });
      expect(h.store.record({ taskId, attempt: 2 })?.escalation).toBe('stalled');
      expect(inbox.map((event) => [event.kind, event.summary])).toEqual([
        ['environment', `environment: the same tool blocker twice; task parked: ${errorLine}`],
      ]);
      expect(h.store.events(taskId, 2).map((event) => event.kind)).not.toContain('stale-tool-blocker-retry');
    });
  });

test('a different tool blocker resumes the same session and the retry prompt says to rerun the failing command', async () => {
  await withRetryFixture(
    async (job, h, taskId, inbox) => {
      failAttempt(h, taskId, 2, { error: 'EMFILE: too many open files, watch', commit: true });
      job.onAttemptExit({ taskId, attempt: 2 });
      await job.drain();

      expect(inbox).toEqual([]);
      expect(h.store.task(taskId).currentAttempt).toBe(3);
      expect(h.store.attempt({ taskId, attempt: 2 }).escalation).toBe('environment');
      expect(h.store.attempt({ taskId, attempt: 3 }).session).toBe('fixture-session');
      const prompt = readFileSync(join(h.store.task(taskId).worktree, '.temp/goal-test-prompts', '3'), 'utf8');
      expect(prompt).toContain('The retry manifest records a failure from an earlier attempt');
      expect(prompt).toContain('Rerun the failing command once before reporting any blocker');
    },
    { commit: true },
  );
});

test('two consecutive dev product tool blockers without a new commit stop the task', async () => {
  await withRetryFixture(async (job, h, taskId, inbox) => {
    failAttempt(h, taskId, 2, { error: 'EMFILE: too many open files, watch' });
    job.onAttemptExit({ taskId, attempt: 2 });
    await job.drain();

    expect(h.store.task(taskId)).toMatchObject({ currentAttempt: 2, state: 'stopped' });
    expect(inbox.map((event) => [event.kind, event.summary])).toEqual([
      ['stalled', 'No new commit in two consecutive attempts: EMFILE: too many open files, watch'],
    ]);
  });
});

test('tool-blocker retries back off by fingerprint across tasks: first, second, then later sightings', () => {
  const h = harness();
  try {
    h.settings.toolRetryBackoffMs = [120_000, 600_000, 1_800_000];
    const ids = [1, 2, 3, 4].map(() => h.tasks.dispatch(h.briefFile).id);
    const fingerprint = blockerFingerprint({
      blocker: 'ssh: connect to host b port 22: Connection refused',
      result: '',
    });
    expect(fingerprint).toBe(
      blockerFingerprint({ blocker: 'ssh: connect to host b port 2222: Connection refused', result: '' }),
    );
    const delays = ids.map((taskId) => toolRetryDelay(h.store, h.settings, { taskId, attempt: 0 }, fingerprint));
    expect(delays).toEqual([120_000, 600_000, 1_800_000, 1_800_000]);
    expect(toolRetryDelay(h.store, h.settings, { taskId: ids[0]!, attempt: 0 }, 'another blocker')).toBe(120_000);
    // Sightings older than an hour no longer count.
    expect(
      toolRetryDelay(h.store, h.settings, { taskId: ids[0]!, attempt: 0 }, fingerprint, Date.now() + 3_700_000),
    ).toBe(120_000);
  } finally {
    h.dispose();
  }
});

test('three distinct tasks with one normalized blocker open one incident and hold their retries', async () => {
  await withThreeTaskIncident(async (_job, h, taskIds, inbox) => {
    const dependency = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: dependency.id, attempt: 0 }, (task) => {
      task.state = 'running';
    });
    const held = h.store.createTask(
      { ...brief(), after: [dependency.id] },
      { briefPath: 'held.md', worktree: h.root, branch: 'worker/held', base: 'base' },
      'implementation',
      'held-status',
    );
    const pending = h.tasks.dispatch(h.briefFile);
    const sourceAttempt = h.store.attempt({ taskId: taskIds[0]!, attempt: 1 });
    const pendingAttempt = h.store.nextAttempt({ taskId: pending.id, attempt: 0 }, (attempt) => ({
      ...sourceAttempt,
      taskId: pending.id,
      attempt,
      failureKind: null,
      blocker: null,
      result: 'RESULT: retry queued',
    }));
    const pendingUntil = new Date(Date.now() + 60_000).toISOString();
    h.store.saveRetryIntent({ taskId: pending.id, attempt: pendingAttempt.attempt }, { notBefore: pendingUntil });
    const cohort = h.store.tasks();
    const incident = listOpenToolIncidents(h.store)[0]!;
    const expectedTasks = cohort.map((task) =>
      task.id === held.id
        ? {
            ...task,
            urgent: false,
            dependencies: [{ id: dependency.id, state: 'running', ready: false }],
            waitingFor: [dependency.id],
          }
        : task.id === pending.id
          ? { ...task, urgent: false, pendingRetry: { reason: 'backoff', until: pendingUntil } }
          : taskIds.includes(task.id)
            ? {
                ...task,
                urgent: false,
                pendingRetry: {
                  reason: 'environment-incident',
                  incidentId: incident.id,
                  nextProbeAt: incident.nextProbeAt,
                  isProbe: incident.probe.taskId === task.id,
                },
              }
            : { ...task, urgent: false },
    );
    const expected = {
      devVerification: devVerificationState(
        h.settings.mainCheckout,
        h.settings.stateDirectory,
        h.settings.integrationBranch,
        cohort,
      ),
      toolIncidents: [incident],
      tasks: expectedTasks,
      trains: [
        { lane: 'main', state: 'missing' },
        { lane: 'dev', state: 'missing' },
      ],
    };
    h.store.db
      .query('INSERT INTO worker_events(task_id,attempt,kind,at,body) VALUES (?,?,?,?,?)')
      .run(taskIds[0]!, 1, 'tool-blocker-incident-state', new Date().toISOString(), '{malformed');
    const cohortRead = spyOn(h.store, 'tasks');
    const taskRead = spyOn(h.store, 'task');
    const attemptRead = spyOn(h.store, 'attempt');
    const retryRead = spyOn(h.store, 'retryIntent');
    const taskStateRead = spyOn(h.store, 'taskState');
    const queryRead = spyOn(h.store.db, 'query');
    const output: string[] = [];
    await runWorkerCommand('status', [], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      inbox: { deliver: (event) => inbox.push(event) },
      print: (value) => output.push(value),
    });
    const status = JSON.parse(output.at(-1)!) as {
      toolIncidents: Array<{ line: string; taskIds: string[]; probe: { taskId: string }; nextProbeAt: string }>;
      tasks: Array<{ id: string; currentAttempt: number; pendingRetry?: { reason: string } }>;
    };
    expect(status).toMatchObject({
      devVerification: expected.devVerification,
      toolIncidents: expected.toolIncidents,
      trains: expected.trains,
      taskCounts: { total: cohort.length },
      tasks: expectedTasks.map((task) => ({
        id: task.id,
        sequence: task.sequence,
        brief: { goal: task.brief.goal, manager: task.brief.manager },
        taskClass: task.taskClass,
        state: task.state,
        currentAttempt: task.currentAttempt,
        urgent: false,
        ...('dependencies' in task && task.dependencies ? { dependencies: task.dependencies } : {}),
        ...('waitingFor' in task && task.waitingFor ? { waitingFor: task.waitingFor } : {}),
        ...('pendingRetry' in task && task.pendingRetry ? { pendingRetry: task.pendingRetry } : {}),
      })),
    });
    expect(cohortRead).toHaveBeenCalledTimes(1);
    expect(taskRead).not.toHaveBeenCalled();
    expect(attemptRead).toHaveBeenCalledTimes(cohort.filter((task) => task.currentAttempt > 0).length);
    expect(retryRead).toHaveBeenCalledTimes(cohort.filter((task) => task.currentAttempt > 0).length);
    expect(taskStateRead).not.toHaveBeenCalled();
    expect(
      queryRead.mock.calls.filter(
        ([sql]) => sql === 'SELECT sequence, body FROM worker_events WHERE kind=? ORDER BY sequence',
      ),
    ).toHaveLength(1);
    expect(status.toolIncidents).toHaveLength(1);
    expect(status.toolIncidents[0]).toMatchObject({
      line: 'enospc: no space left on device at <worktree>/cache-# errno #',
      taskIds,
    });
    expect(status.toolIncidents[0]!.nextProbeAt).toBeTruthy();
    expect(status.tasks.filter((task) => taskIds.includes(task.id)).map((task) => task.pendingRetry?.reason)).toEqual([
      'environment-incident',
      'environment-incident',
      'environment-incident',
    ]);
    expect(status.tasks.filter((task) => taskIds.includes(task.id)).map((task) => task.currentAttempt)).toEqual([
      1, 1, 1,
    ]);
    expect(inbox.filter((event) => event.kind === 'blocker')).toHaveLength(1);
    expect(inbox.find((event) => event.kind === 'blocker')?.summary).toContain('Source location (git grep):');

    cohortRead.mockClear();
    taskRead.mockClear();
    attemptRead.mockClear();
    retryRead.mockClear();
    taskStateRead.mockClear();
    queryRead.mockClear();
    const qualifiedOutput: string[] = [];
    await runWorkerCommand('status', [taskIds[0]!], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print: (value) => qualifiedOutput.push(value),
    });
    expect(JSON.parse(qualifiedOutput.at(-1)!)).toMatchObject({
      ...expectedTasks[0],
      toolIncidents: [incident],
      trains: expected.trains,
    });
    expect(cohortRead).not.toHaveBeenCalled();
    expect(taskRead).toHaveBeenCalledTimes(1);
    expect(attemptRead).toHaveBeenCalledTimes(1);
    expect(retryRead).toHaveBeenCalledTimes(1);
    expect(taskStateRead).toHaveBeenCalledTimes(1);
    expect(
      queryRead.mock.calls.filter(
        ([sql]) => sql === 'SELECT sequence, body FROM worker_events WHERE kind=? ORDER BY sequence',
      ),
    ).toHaveLength(1);

    h.store.updateTask({ taskId: incident.probe.taskId, attempt: incident.probe.attempt }, (task) => {
      task.state = 'integrated';
    });
    cohortRead.mockClear();
    taskRead.mockClear();
    attemptRead.mockClear();
    retryRead.mockClear();
    taskStateRead.mockClear();
    queryRead.mockClear();
    const finishedProbeOutput: string[] = [];
    await runWorkerCommand('status', [taskIds[0]!], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print: (value) => finishedProbeOutput.push(value),
    });
    expect(JSON.parse(finishedProbeOutput.at(-1)!)).toMatchObject({
      ...h.store.task(taskIds[0]!),
      urgent: false,
      pendingRetry: { reason: 'start' },
      toolIncidents: [],
      trains: expected.trains,
    });
    expect(taskStateRead).toHaveBeenCalledTimes(1);
    expect(
      queryRead.mock.calls.filter(
        ([sql]) => sql === 'SELECT sequence, body FROM worker_events WHERE kind=? ORDER BY sequence',
      ),
    ).toHaveLength(1);
    cohortRead.mockRestore();
    taskRead.mockRestore();
    attemptRead.mockRestore();
    retryRead.mockRestore();
    taskStateRead.mockRestore();
    queryRead.mockRestore();
  });
});

test('a passing incident probe releases the other held retries', async () => {
  await withThreeTaskIncident(async (job, h, taskIds, inbox) => {
    const incidentOutput: string[] = [];
    await runWorkerCommand('status', [], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print: (value) => incidentOutput.push(value),
    });
    const incident = (
      JSON.parse(incidentOutput.at(-1)!) as {
        toolIncidents: Array<{ nextProbeAt: string }>;
      }
    ).toolIncidents[0]!;
    const originalNow = Date.now;
    Date.now = () => Date.parse(incident.nextProbeAt) + 1;
    try {
      job.resumePendingRetries();
      await job.drain();
    } finally {
      Date.now = originalNow;
    }
    expect(
      h.store
        .tasks()
        .filter((task) => taskIds.includes(task.id))
        .map((task) => task.currentAttempt),
    ).toEqual([2, 2, 2]);
    const releasedStatus: string[] = [];
    await runWorkerCommand('status', [], {
      settings: h.settings,
      store: h.store,
      tasks: h.tasks,
      print: (value) => releasedStatus.push(value),
    });
    expect((JSON.parse(releasedStatus.at(-1)!) as { toolIncidents: unknown[] }).toolIncidents).toEqual([]);
    expect(inbox.filter((event) => event.kind === 'blocker')).toHaveLength(1);
  });
});

test('a pending retry waits for its backoff time and for check hosts in a probed outage', async () => {
  await withRetryFixture(
    async (job, h, taskId) => {
      const ref = { taskId, attempt: 2 };
      failAttempt(h, taskId, 2, { error: 'Connection closed by 10.0.0.2 port 22', commit: true });
      h.store.updateTask(ref, (task) => {
        task.state = 'ready';
      });
      h.store.saveRetryIntent(ref, {
        escalation: 'environment',
        notBefore: new Date(Date.now() + 600_000).toISOString(),
        awaitCheckHosts: true,
      });
      job.resumePendingRetries();
      await job.drain();
      expect(h.store.task(taskId).currentAttempt).toBe(2);
      expect(h.store.retryIntent(ref)?.status).toBe('pending');

      // The backoff has passed, but the watchdog saw check host b fail its last two probes.
      const state = h.settings.stateDirectory;
      writeFileSync(
        join(state, 'remote-check-hosts.json'),
        JSON.stringify({
          hosts: [{ name: 'b', address: 'check@b.example', identity: '/fixture/identity', performance: true }],
        }),
      );
      writeFileSync(join(state, 'watchdog.json'), JSON.stringify({ alerts: {}, hostProbeFailures: { b: 2 } }));
      h.store.updateRetryIntent(ref, (intent) => {
        intent.options.notBefore = new Date(Date.now() - 1_000).toISOString();
      });
      job.resumePendingRetries();
      await job.drain();
      expect(h.store.task(taskId).currentAttempt).toBe(2);
      expect(h.store.events(taskId, 2).filter((event) => event.kind === 'retry-awaits-check-hosts')).toHaveLength(1);

      // A successful probe clears the outage; the next sweep resumes the session.
      writeFileSync(join(state, 'watchdog.json'), JSON.stringify({ alerts: {}, hostProbeFailures: {} }));
      job.resumePendingRetries();
      await job.drain();
      expect(h.store.task(taskId).currentAttempt).toBe(3);
      expect(h.store.attempt({ taskId, attempt: 3 }).session).toBe('fixture-session');
    },
    { commit: true },
  );
});

test('a check-host transport blocker asks its retry to wait for healthy check hosts', async () => {
  await withRetryFixture(
    async (_job, h, taskId) => {
      const intent = h.store.retryIntent({ taskId, attempt: 1 });
      expect(intent?.options.awaitCheckHosts).toBe(true);
      expect(h.store.task(taskId).currentAttempt).toBe(2);
    },
    { error: 'rsync error: unexplained error (code 255)', commit: true },
  );
});
