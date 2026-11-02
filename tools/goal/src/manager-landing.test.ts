import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Attempt, Brief, Profile, Task } from './types.ts';
import { createRuntime, loadSettings } from './config.ts';
import type { IntegrationRuntime } from './integration-cli.ts';
import { runIntegration } from './integration-cli.ts';
import { CONTROL_PLANE_CHECKS, MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { assertManagerLandingEvidence, requestManagerLanding } from './manager-landing.ts';
import { CLASSIFIER_VERSION, emptySteps, emptyTokens } from './records.ts';
import { openDb } from './db.ts';
import { SqliteLandingQueue } from './land.ts';
import { WorkerStore } from './store.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { WorkerTasks } from './tasks.ts';
import { harness, repository } from './test-support.ts';

type Fixture = {
  path: string;
  main: string;
  stateDirectory: string;
  worktreeRoot: string;
  db: Database;
  store: WorkerStore;
  queue: SqliteLandingQueue;
  job: WorkerJob;
  close(): void;
};

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function setup(): Fixture {
  const repo = repository();
  const stateDirectory = join(repo.path, 'state');
  const worktreeRoot = join(repo.path, 'trees');
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  git(repo.main, 'branch', 'dev');
  const db = openDb(join(stateDirectory, 'goal.sqlite'));
  const store = new WorkerStore(db);
  const queue = new SqliteLandingQueue(db, store);
  const loaded = loadSettings({ cwd: repo.main });
  const settings = {
    ...loaded,
    mainCheckout: repo.main,
    stateDirectory,
    worktreeRoot,
    integration: { ...loaded.integration, inboxDirectory: join(stateDirectory, 'inboxes') },
  };
  const tasks = new WorkerTasks(settings, store);
  const inbox = new SqliteManagerInbox(db, settings.integration.inboxDirectory);
  const job = new WorkerJob(tasks, queue, inbox);
  const fixture: Fixture = {
    path: repo.path,
    main: repo.main,
    stateDirectory,
    worktreeRoot,
    db,
    store,
    queue,
    job,
    close() {
      db.close();
      repo.close();
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function brief(goal: string, manager: string, path: string): Brief {
  return {
    goal,
    manager,
    kind: 'implementation',
    paths: [path],
    riskAreas: [],
    acceptance: { command: ['expensive-worker-acceptance', goal], tests: [], failing: true },
    estimate: { lines: 20, files: 1 },
    criticalPath: false,
    waiting: [],
    after: [],
    inseparable: false,
    citesSources: false,
    hostileInput: false,
    markdown: '',
    ...(goal === 'control-plane' ? { target: 'main' as const } : {}),
  };
}

function successfulAttempt(taskId: string, attempt: number): Attempt {
  const now = new Date().toISOString();
  const profile: Profile = { cli: 'codex', model: 'fixture', effort: 'high', poolClass: 'codex' };
  return {
    taskId,
    attempt,
    state: 'exited',
    profile,
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: now,
    endedAt: now,
    process: null,
    driver: null,
    logPath: '',
    evidencePath: '',
    auxiliaryProcesses: [],
    session: 'fixture-session',
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: 0,
    result: 'RESULT: success',
    blocker: null,
    approaches: [],
  };
}

function createAcceptedTask(
  fixture: Fixture,
  options: { id: string; goal?: string; manager: string; file: string; committed?: boolean; request?: boolean },
): Task {
  const goal = options.goal ?? 'feature';
  const baseBranch = goal === 'control-plane' ? 'main' : 'dev';
  const base = git(fixture.main, 'rev-parse', `refs/heads/${baseBranch}`);
  const branch = `worker-${options.id}`;
  const worktree = join(fixture.worktreeRoot, options.id);
  git(fixture.main, 'worktree', 'add', '-b', branch, worktree, base);
  if (options.committed !== false) {
    const file = join(worktree, options.file);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `export const ${options.id.replace(/[^a-z0-9]/gi, '_')} = true;\n`);
    git(worktree, 'add', '--', options.file);
    git(worktree, 'commit', '-m', `accepted ${options.id}`);
  }
  const task = fixture.store.createTask(
    brief(
      goal,
      options.manager,
      options.file.includes('/') ? options.file.slice(0, options.file.lastIndexOf('/') + 1) + '**' : options.file,
    ),
    { briefPath: join(fixture.stateDirectory, `${options.id}.md`), worktree, branch, base },
    'implementation',
    options.id,
  );
  const ref = { taskId: task.id, attempt: 0 };
  fixture.store.nextAttempt(ref, (attempt) => successfulAttempt(task.id, attempt));
  const current = { taskId: task.id, attempt: 1 };
  fixture.store.updateTask(current, (value) => {
    value.state = 'landing';
  });
  const attempt = fixture.store.attempt(current);
  fixture.store.putRecord({
    taskId: task.id,
    attempt: 1,
    taskClass: task.taskClass,
    profile: attempt.profile,
    pool: attempt.pool,
    tableVersion: attempt.tableVersion,
    experiment: attempt.experiment,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt!,
    steps: 1,
    criticalPath: false,
    tokens: emptyTokens(),
    before: null,
    after: null,
    outcome: 'pending-gate',
    firstFailure: null,
    escalation: null,
    consulted: false,
    fixRound: 0,
    diffLines: null,
    changedFiles: null,
    hostMs: null,
    classifierVersion: CLASSIFIER_VERSION,
    stepClasses: emptySteps(),
    earlyStop: false,
  });
  if (options.request !== false) {
    const request = landing(fixture, task.id);
    fixture.store.write(current, () => fixture.store.landing(request, (queued) => fixture.queue.enqueue(queued)));
  }
  return fixture.store.task(task.id);
}

function landing(fixture: Fixture, taskId: string) {
  const task = fixture.store.task(taskId);
  return {
    taskId,
    attempt: task.currentAttempt,
    branch: task.branch,
    worktree: task.worktree,
    declaredPaths: task.brief.paths,
    protectedPaths: [],
    gate: task.brief.acceptance.command,
  };
}

function runtime(fixture: Fixture, counts: { handoffs: number; pumps: number }): IntegrationRuntime {
  return {
    db: fixture.db,
    mainCheckout: fixture.main,
    stateDirectory: fixture.stateDirectory,
    worktreeRoot: fixture.worktreeRoot,
    managerSocket: join(fixture.stateDirectory, 'missing-manager.sock'),
    fence: fixture.store,
    sink: fixture.job,
    queue: fixture.queue,
    landing: (taskId) => landing(fixture, taskId),
    manager: () => {
      throw new Error('manager creation is not part of land');
    },
    managerServices: {} as IntegrationRuntime['managerServices'],
    managerLand: (taskId, managerId) =>
      requestManagerLanding(taskId, managerId, fixture.store, fixture.queue, (id) => landing(fixture, id)),
    handoffTrain: async () => {
      counts.handoffs++;
    },
    pump: async () => {
      counts.pumps++;
    },
  };
}

async function withEnvironment<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function train(
  fixture: Fixture,
  runGate: (command: readonly string[], cwd: string) => Promise<boolean>,
  options: {
    promote?: () => Promise<void>;
  } = {},
) {
  return new MergeTrain({
    mainCheckout: fixture.main,
    stateDirectory: fixture.stateDirectory,
    worktreeRoot: fixture.worktreeRoot,
    mainBranch: 'main',
    integrationBranch: 'dev',
    stabilizeBranch: 'stabilize',
    integration: { batchSize: 1, batchAcceptanceConcurrency: 1, devLandingChecks: true },
    integrationChecks: [],
    affectedTests: [],
    formatCommand: ['/bin/true'],
    queue: fixture.queue,
    fence: fixture.store,
    sink: fixture.job,
    runGate: async (command, cwd) => {
      const passed = await runGate(command, cwd);
      return { passed, output: passed ? '' : 'unexpected check failure', timedOut: false };
    },
    runLaunchSmoke: async (_command, cwd) => {
      const candidate = git(cwd, 'rev-parse', 'HEAD');
      const devScriptTree = git(cwd, 'rev-parse', 'refs/heads/dev');
      return {
        passed: true,
        output:
          `release evidence: candidate=${candidate} dev-script-tree=${devScriptTree} ` +
          'scenarios=manager-landing:passed lifecycle-regressions=manager-landing:passed\n',
        timedOut: false,
      };
    },
    ...(options.promote ? { promote: options.promote } : {}),
  });
}

test('Owning manager land command integrates its ready accepted work without acceptance rerun while foreign manager and worker requests are refused', async () => {
  const fixture = setup();
  const task = createAcceptedTask(fixture, {
    id: 'owner-task',
    manager: 'owner-manager',
    file: 'src/accepted.ts',
  });
  const counts = { handoffs: 0, pumps: 0 };
  const integrationRuntime = runtime(fixture, counts);
  await withEnvironment(
    { GOAL_MANAGER: 'foreign-manager', GOAL_TASK_ID: undefined, GOAL_ATTEMPT: undefined },
    async () => {
      await expect(runIntegration(['land', task.id], integrationRuntime)).rejects.toThrow('does not own task');
    },
  );
  await withEnvironment({ GOAL_MANAGER: 'owner-manager', GOAL_TASK_ID: 'worker-task', GOAL_ATTEMPT: '1' }, async () => {
    await expect(runIntegration(['land', task.id], integrationRuntime)).rejects.toThrow('Workers cannot');
  });
  await withEnvironment(
    { GOAL_MANAGER: 'owner-manager', GOAL_TASK_ID: undefined, GOAL_ATTEMPT: undefined },
    async () => {
      await expect(runIntegration(['land', task.id, '--evidence', 'fake.log'], integrationRuntime)).rejects.toThrow(
        'usage: land <task>',
      );
      expect(await runIntegration(['land', task.id], integrationRuntime)).toBe(0);
      const queued = fixture.queue.next();
      expect(queued?.request.managerLanding).toEqual({
        managerId: 'owner-manager',
        acceptedCommit: git(task.worktree, 'rev-parse', 'HEAD'),
        acceptanceCommand: task.brief.acceptance.command,
      });
      expect(counts).toEqual({ handoffs: 1, pumps: 0 });
      await expect(runIntegration(['land', task.id], integrationRuntime)).resolves.toBe(0);
      expect(counts).toEqual({ handoffs: 1, pumps: 0 });
    },
  );

  const acceptanceRuns: string[] = [];
  await train(fixture, async (command) => {
    acceptanceRuns.push(command.join(' '));
    return true;
  }).run();
  await fixture.job.drain();
  const integrated = fixture.store.task(task.id);
  expect(integrated.state).toBe('integrated');
  expect(integrated.integratedCommit).toBe(git(fixture.main, 'rev-parse', 'refs/heads/dev'));
  expect(acceptanceRuns).not.toContain(task.brief.acceptance.command.join(' '));
});

test('manager settlement leaves accepted queue work for explicit owner authorization', async () => {
  const worker = harness();
  const runtime = createRuntime({ settings: worker.settings, trainMode: 'inline' });
  const previousManager = process.env.GOAL_MANAGER;
  const previousThread = process.env.CODEX_THREAD_ID;
  let pumps = 0;
  runtime.train.pump = async () => {
    pumps++;
  };
  try {
    process.env.GOAL_MANAGER = 'fixture';
    delete process.env.CODEX_THREAD_ID;
    await runtime.job.afterSettle();
    expect(pumps).toBe(0);
    delete process.env.GOAL_MANAGER;
    await runtime.job.afterSettle();
    expect(pumps).toBe(1);
  } finally {
    if (previousManager === undefined) delete process.env.GOAL_MANAGER;
    else process.env.GOAL_MANAGER = previousManager;
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    runtime.close();
    worker.dispose();
  }
});

test('manager landing refuses unfinished attempts, stale work, missing commits and dirty accepted trees', () => {
  const fixture = setup();
  const unfinished = createAcceptedTask(fixture, {
    id: 'unfinished',
    manager: 'owner-manager',
    file: 'src/unfinished.ts',
    request: false,
  });
  fixture.store.updateAttempt({ taskId: unfinished.id, attempt: 1 }, (attempt) => {
    attempt.state = 'running';
    attempt.endedAt = null;
    attempt.exitCode = null;
  });
  expect(() =>
    requestManagerLanding(unfinished.id, 'owner-manager', fixture.store, fixture.queue, (id) => landing(fixture, id)),
  ).toThrow('completed accepted current attempt');

  const noCommit = createAcceptedTask(fixture, {
    id: 'no-commit',
    manager: 'owner-manager',
    file: 'src/no-commit.ts',
    committed: false,
    request: false,
  });
  expect(() =>
    requestManagerLanding(noCommit.id, 'owner-manager', fixture.store, fixture.queue, (id) => landing(fixture, id)),
  ).toThrow('no committed work');

  const accepted = createAcceptedTask(fixture, {
    id: 'dirty',
    manager: 'owner-manager',
    file: 'src/dirty.ts',
    request: false,
  });
  writeFileSync(join(accepted.worktree, 'untracked.txt'), 'not accepted\n');
  expect(() =>
    requestManagerLanding(accepted.id, 'owner-manager', fixture.store, fixture.queue, (id) => landing(fixture, id)),
  ).toThrow('clean worktree');

  const stale = createAcceptedTask(fixture, {
    id: 'stale',
    manager: 'owner-manager',
    file: 'src/stale.ts',
    request: false,
  });
  const staleEvidence = {
    ...landing(fixture, stale.id),
    managerLanding: {
      managerId: 'owner-manager',
      acceptedCommit: git(stale.worktree, 'rev-parse', 'HEAD'),
      acceptanceCommand: [...stale.brief.acceptance.command],
    },
  };
  fixture.store.nextAttempt({ taskId: stale.id, attempt: 1 }, (attempt) => successfulAttempt(stale.id, attempt));
  expect(() => assertManagerLandingEvidence(staleEvidence, fixture.store)).toThrow('stale');
  expect(() =>
    requestManagerLanding(stale.id, 'owner-manager', fixture.store, fixture.queue, (id) => landing(fixture, id)),
  ).toThrow('not ready to land');
});

test('Main/control-plane landing retains mandatory lifecycle gate and promotion discipline', async () => {
  const fixture = setup();
  const task = createAcceptedTask(fixture, {
    id: 'control-plane-owner',
    goal: 'control-plane',
    manager: 'control-plane-manager',
    file: 'tools/goal/src/accepted.ts',
  });
  const counts = { handoffs: 0, pumps: 0 };
  const integrationRuntime = runtime(fixture, counts);
  const managerGateRuns: string[] = [];
  const compatibilityInstallRuns: string[] = [];
  const compatibilityContractRuns: { command: string[]; cwd: string }[] = [];
  const managerPromotions: string[] = [];
  await withEnvironment(
    { GOAL_MANAGER: 'control-plane-manager', GOAL_TASK_ID: undefined, GOAL_ATTEMPT: undefined },
    async () => {
      await runIntegration(['land', task.id], integrationRuntime);
    },
  );
  expect(managerGateRuns).toEqual([]);
  expect(git(fixture.main, 'rev-parse', 'refs/heads/main')).toBe(task.base);
  expect(counts).toEqual({ handoffs: 1, pumps: 0 });

  const controller = train(
    fixture,
    async (command, cwd) => {
      if (cwd.includes('control-plane-dev-')) compatibilityInstallRuns.push(command.join(' '));
      else if (command[1] === 'tools/goal/scripts/check-compatibility.ts')
        compatibilityContractRuns.push({ command: [...command], cwd });
      else managerGateRuns.push(command.join(' '));
      return true;
    },
    {
      promote: async () => {
        managerPromotions.push(git(fixture.main, 'rev-parse', 'refs/heads/main'));
      },
    },
  );
  await controller.run();
  await fixture.job.drain();
  const mainHead = git(fixture.main, 'rev-parse', 'refs/heads/main');
  expect(fixture.store.task(task.id).integratedCommit).toBe(mainHead);
  expect(managerGateRuns).toEqual(CONTROL_PLANE_CHECKS.map((command) => command.join(' ')));
  expect(compatibilityInstallRuns).toEqual(['bun install --frozen-lockfile']);
  expect(compatibilityContractRuns).toHaveLength(1);
  expect(compatibilityContractRuns[0]?.command.slice(0, 3)).toEqual([
    'bun',
    'tools/goal/scripts/check-compatibility.ts',
    '--scripts-root',
  ]);
  expect(compatibilityContractRuns[0]?.command[3]).toContain('control-plane-dev-');
  expect(managerPromotions).toContain(mainHead);
  expect(existsSync(join(fixture.main, 'tools/goal/src/accepted.ts'))).toBe(true);
});
