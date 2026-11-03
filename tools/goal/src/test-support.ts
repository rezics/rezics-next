import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'bun:test';
import { ownedTemporaryDirectory, removeTemporaryDirectory } from '../../../scripts/tmp-janitor.ts';
import { git as repositoryGit } from './merge.ts';

import { loadSettings } from './config.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks, git } from './tasks.ts';
import type { Brief, Pool, PoolReading, Settings, Task } from './types.ts';
import { StaleAttemptError, type AttemptFence, type GateOutcome, type ManagerEvent } from './contracts.ts';
import { WorkerJob } from './job.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { PROMOTION_GATE_TIMEOUT_MS, promote } from './promotion.ts';
import { gateRunner, type GateRunner } from './merge.ts';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import {
  checkedProcessGroup,
  inspectProcessIdentity,
  sameProcess,
  signalProcessIdentity,
  waitForWorkerExit,
  type ProcessIdentity,
} from './process.ts';
import {
  beginFixtureProcessDisposal,
  createFixtureProcessOwner,
  fixtureOwnedProcesses,
  hasUnsettledFixtureWaits,
  settleFixtureWaits,
} from './fixture-process-ownership.ts';

const FIXTURE_TERM_GRACE_MS = 300;
const FIXTURE_KILL_WAIT_MS = 1500;
const FIXTURE_FAKE_WORKER_LIFETIME_MS = 60_000;
const fixtureDisposals = new Map<string, () => void | Promise<void>>();
afterEach(async () => {
  const failures: unknown[] = [];
  for (const [path, dispose] of [...fixtureDisposals].reverse()) {
    try {
      await dispose();
      fixtureDisposals.delete(path);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'temporary fixture cleanup failed');
});

function boundedFixtureWorkerScript(script: string): string {
  const guard =
    `const __goalFixtureWorkerLifetime = setTimeout(() => process.exit(124), ${FIXTURE_FAKE_WORKER_LIFETIME_MS});\n` +
    '__goalFixtureWorkerLifetime.unref?.();\n';
  return script.replace(/^(#![^\n]*\n)/, `$1${guard}`);
}

function checkedFixtureGroup(identity: ProcessIdentity, _allowLeaderExit = false): ProcessIdentity[] {
  return checkedProcessGroup(identity);
}

async function signalFixtureGroup(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
  for (const member of checkedFixtureGroup(identity)) await signalProcessIdentity(member, signal);
}

async function waitForFixtureGroupExit(identity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (checkedFixtureGroup(identity, true).length) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function reapFixtureGroup(identity: ProcessIdentity): Promise<void> {
  if (!checkedFixtureGroup(identity).length) return;
  await signalFixtureGroup(identity, 'SIGTERM');
  if (await waitForFixtureGroupExit(identity, FIXTURE_TERM_GRACE_MS)) return;
  await signalFixtureGroup(identity, 'SIGKILL');
  if (!(await waitForFixtureGroupExit(identity, FIXTURE_KILL_WAIT_MS)))
    throw new Error(
      `owned fixture process group ${identity.group} did not exit after SIGKILL within ${FIXTURE_KILL_WAIT_MS}ms`,
    );
}

function checkedFixtureWaiter(identity: ProcessIdentity): boolean {
  const current = inspectProcessIdentity(identity.pid);
  if (current && !sameProcess(identity))
    throw new Error('fixture-owned waiter identity changed; refusing to signal reused PID');
  return Boolean(current);
}

async function waitForFixtureWaiterExit(identity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (checkedFixtureWaiter(identity)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function reapFixtureWaiter(identity: ProcessIdentity): Promise<void> {
  if (!checkedFixtureWaiter(identity)) return;
  await signalProcessIdentity(identity, 'SIGTERM');
  if (await waitForFixtureWaiterExit(identity, FIXTURE_TERM_GRACE_MS)) return;
  if (checkedFixtureWaiter(identity)) {
    await signalProcessIdentity(identity, 'SIGKILL');
  }
  if (!(await waitForFixtureWaiterExit(identity, FIXTURE_KILL_WAIT_MS)))
    throw new Error(`owned fixture waiter ${identity.pid} did not exit after SIGKILL within ${FIXTURE_KILL_WAIT_MS}ms`);
}

function hasLiveFixtureProcess(stateDirectory: string, token: string): boolean {
  const processes = fixtureOwnedProcesses(stateDirectory, token);
  if (hasUnsettledFixtureWaits(stateDirectory, token)) return true;
  return processes.some((owned) =>
    owned.role === 'worker' ? checkedFixtureGroup(owned.identity).length > 0 : checkedFixtureWaiter(owned.identity),
  );
}

/** Copy the actual worker-check runtime closure from one immutable development commit. */
export function checkScriptFixture(ref = 'refs/heads/dev') {
  const repositoryRoot = resolve(import.meta.dir, '../../..');
  const commit = repositoryGit(repositoryRoot, 'rev-parse', '--verify', `${ref}^{commit}`);
  function read(path: string): string {
    const result = spawnSync('git', ['show', `${commit}:${path}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(result.stderr?.trim() || result.error?.message || `Could not read ${commit}:${path}`);
    return result.stdout;
  }
  return {
    read,
    install(root: string, transform: (path: string, source: string) => string = (_path, source) => source) {
      for (const path of [
        'scripts/worker-check.ts',
        'scripts/remote-check.ts',
        'scripts/check-git.ts',
        'scripts/check-ledger.ts',
        'scripts/stack-run.ts',
        'scripts/stack-lease.ts',
        'scripts/check-custody.ts',
        'scripts/check-artifacts.ts',
        'scripts/check-memory.ts',
        'scripts/check-host/docker',
      ]) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        const source = read(path);
        writeFileSync(target, transform(path, source));
        if (path === 'scripts/worker-check.ts' && source.includes("'./tmp-janitor.ts'"))
          writeFileSync(join(root, 'scripts/tmp-janitor.ts'), read('scripts/tmp-janitor.ts'));
      }
    },
  };
}

export function temporaryDirectory(): { path: string; close(): void } {
  const root = resolve(import.meta.dir, '../../../.temp/goal-tests');
  const inherited = resolve(tmpdir());
  const temporary = ownedTemporaryDirectory(inherited.startsWith(`${root}/`) ? inherited : root, 'case-');
  const close = () => {
    temporary.close();
    fixtureDisposals.delete(temporary.path);
  };
  fixtureDisposals.set(temporary.path, close);
  return { path: temporary.path, close };
}
export function repository() {
  const temporary = temporaryDirectory();
  const main = join(temporary.path, 'main');
  mkdirSync(main);
  repositoryGit(main, 'init', '-b', 'main');
  repositoryGit(main, 'config', 'user.email', 'test@example.invalid');
  repositoryGit(main, 'config', 'user.name', 'Test');
  writeFileSync(join(main, 'base'), 'base\n');
  repositoryGit(main, 'add', '.');
  repositoryGit(main, 'commit', '-m', 'Initial');
  return {
    ...temporary,
    main,
    commit(file: string, content = file) {
      writeFileSync(join(main, file), content);
      repositoryGit(main, 'add', '--', file);
      repositoryGit(main, 'commit', '-m', `Change ${file}`);
    },
    branch(name: string, file: string, content = file) {
      const worker = join(temporary.path, name);
      repositoryGit(main, 'worktree', 'add', '-b', name, worker, 'main');
      mkdirSync(dirname(join(worker, file)), { recursive: true });
      writeFileSync(join(worker, file), content);
      repositoryGit(worker, 'add', '.');
      repositoryGit(worker, 'commit', '-m', `Change ${file}`);
      return { taskId: name, attempt: 1, branch: name, worktree: worker, declaredPaths: [file], gate: ['true'] };
    },
  };
}

/** A real-Git landing train fixture for tests that need to inspect candidate publication boundaries. */
export function mergeTrainHarness() {
  const repo = repository();
  const stateDirectory = join(repo.path, 'state');
  mkdirSync(stateDirectory, { recursive: true });
  const db = openDb(join(stateDirectory, 'goal.sqlite'));
  const store = new WorkerStore(db);
  let current = 1;
  const fence: AttemptFence = {
    assertCurrent(ref) {
      if (current !== ref.attempt) throw new StaleAttemptError(ref, current);
    },
    commitMerge(ref, merge) {
      return db
        .transaction(() => {
          fence.assertCurrent(ref);
          return merge();
        })
        .immediate();
    },
  };
  const queue = new SqliteLandingQueue(db, fence);
  const outcomes: GateOutcome[] = [];
  const fixture = {
    ...repo,
    db,
    store,
    fence,
    queue,
    outcomes,
    options: {
      mainCheckout: repo.main,
      stateDirectory,
      worktreeRoot: join(repo.path, 'trees'),
      queue,
      fence,
      sink: {
        onGateOutcome(outcome: GateOutcome) {
          outcomes.push(outcome);
        },
      },
    },
    close() {
      db.close();
      repo.close();
    },
  };
  fixtureDisposals.set(repo.path, () => fixture.close());
  return fixture;
}

export function tempDirectory(): string {
  return temporaryDirectory().path;
}
export const markdown = `---
goal: fixture
kind: implementation
paths: [result.txt]
riskAreas: []
acceptance:
  command: [bun, test]
  tests: [acceptance]
  failing: true
estimate:
  lines: 100
  files: 4
criticalPath: false
waiting: []
---
Write the requested result and commit it.
`;
export function brief(): Brief {
  return parseBrief(markdown, readRiskOwnership(join(import.meta.dir, '../risk-areas.json')));
}
export function fixturePool(directory = '/fixture'): Pool {
  return {
    name: 'fixture',
    cli: 'codex',
    classes: ['codex'],
    configDirectory: directory,
    command: 'codex',
    allowanceKey: 'fixture',
    policy: { weight: 1, reservePercent: 0, allowUnknown: true, maxAgeMs: 60000 },
  };
}
export function reading(pool: Pool, used = 0): PoolReading {
  return {
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    at: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    windows: [{ usedPercent: used, minutes: 10080, resetsAt: Date.now() + 86400000 }],
    exhausted: used >= 100,
    error: null,
  };
}
export function harness(
  script = `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
writeFileSync('result.txt', 'accepted');
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'commit',type:'command_execution',command:'git commit -m fixture'}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:20}}));
`,
): {
  root: string;
  settings: Settings;
  store: WorkerStore;
  tasks: WorkerTasks;
  briefFile: string;
  ownerToken: string;
  dispose(): void;
  disposeAsync(options?: { beforeRemove?: () => void | Promise<void> }): Promise<void>;
} {
  const root = tempDirectory();
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.temp/\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'goal-fixture', private: true, workspaces: ['packages/*'] }),
  );
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/typecheck.ts'), 'process.exit(0);\n');
  mkdirSync(join(root, 'packages/definitions'), { recursive: true });
  writeFileSync(
    join(root, 'packages/definitions/package.json'),
    JSON.stringify({ name: '@fixture/definitions', private: true, scripts: { release: 'true' } }),
  );
  writeFileSync(join(root, 'README.md'), 'Fixture\n');
  writeFileSync(
    join(root, 'fixture.test.ts'),
    "import { expect, test } from 'bun:test';\ntest('fixture acceptance', () => expect(true).toBe(true));\n",
  );
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initial fixture']);
  const state = join(root, '.temp/goal');
  mkdirSync(state, { recursive: true });
  const command = join(state, 'codex');
  writeFileSync(
    command,
    boundedFixtureWorkerScript(script).replaceAll(
      '__GOAL_TEST_DATABASE_PATH__',
      JSON.stringify(join(state, 'goal.sqlite')),
    ),
  );
  chmodSync(command, 0o755);
  const pool = { ...fixturePool(join(state, 'account')), command };
  writeFileSync(join(state, 'local.json'), JSON.stringify({ version: 1, terminationGraceMs: 1000, pools: [pool] }));
  const settings = loadSettings({ cwd: root, env: {} });
  settings.integrationChecks = [];
  mkdirSync(settings.stateDirectory, { recursive: true });
  const ownerToken = createFixtureProcessOwner(settings.stateDirectory);
  const store = new WorkerStore(openDb(join(settings.stateDirectory, 'goal.sqlite'))),
    tasks = new WorkerTasks(settings, store);
  const briefFile = join(state, 'source.md');
  writeFileSync(briefFile, markdown);
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let databaseClosed = false;
  const fixture = {
    root,
    settings,
    store,
    tasks,
    briefFile,
    ownerToken,
    dispose() {
      if (disposed) return;
      if (disposing) throw new Error('fixture disposal is in progress; await h.disposeAsync()');
      beginFixtureProcessDisposal(settings.stateDirectory, ownerToken);
      if (hasLiveFixtureProcess(settings.stateDirectory, ownerToken))
        throw new Error('fixture has live owned processes; await h.disposeAsync() before removing its directory');
      store.db.close();
      databaseClosed = true;
      removeTemporaryDirectory(root);
      fixtureDisposals.delete(root);
      disposed = true;
    },
    disposeAsync(options: { beforeRemove?: () => void | Promise<void> } = {}) {
      if (disposed) return Promise.resolve();
      if (disposing) return disposing;
      const cleanup = async () => {
        beginFixtureProcessDisposal(settings.stateDirectory, ownerToken);
        const processes = fixtureOwnedProcesses(settings.stateDirectory, ownerToken);
        const seenGroups = new Set<string>();
        for (const owned of processes) {
          if (owned.role !== 'worker') continue;
          const { identity } = owned;
          const key = `${identity.boot}:${identity.pid}:${identity.start}:${identity.group}`;
          if (seenGroups.has(key)) continue;
          seenGroups.add(key);
          const waiter = waitForWorkerExit(identity, owned.logPath);
          void waiter.catch(() => {});
        }
        for (const owned of processes) {
          if (owned.role !== 'worker') continue;
          const { identity } = owned;
          const key = `${identity.boot}:${identity.pid}:${identity.start}:${identity.group}`;
          if (!seenGroups.has(key)) continue;
          seenGroups.delete(key);
          await reapFixtureGroup(identity);
        }
        await settleFixtureWaits(settings.stateDirectory, ownerToken);
        const seenWaiters = new Set<string>();
        for (const owned of fixtureOwnedProcesses(settings.stateDirectory, ownerToken)) {
          if (owned.role !== 'waiter') continue;
          const { identity } = owned;
          const key = `${identity.boot}:${identity.pid}:${identity.start}`;
          if (seenWaiters.has(key)) continue;
          seenWaiters.add(key);
          await reapFixtureWaiter(identity);
        }
        if (hasLiveFixtureProcess(settings.stateDirectory, ownerToken))
          throw new Error('fixture-owned process remained live after bounded teardown');
        await options.beforeRemove?.();
        if (hasLiveFixtureProcess(settings.stateDirectory, ownerToken))
          throw new Error('fixture-owned process or continuation appeared before fixture removal');
        if (!databaseClosed) {
          store.db.close();
          databaseClosed = true;
        }
        removeTemporaryDirectory(root);
        fixtureDisposals.delete(root);
        disposed = true;
      };
      disposing = cleanup().catch((error) => {
        disposing = undefined;
        throw error;
      });
      return disposing;
    },
  };
  fixtureDisposals.set(root, () => fixture.disposeAsync());
  return fixture;
}

/** Real workers and Git, with explicit integrated fixtures for the promotion specifications. */
export function integrationHarness() {
  const h = harness(`#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const plan = JSON.parse(readFileSync('.temp/worker-plan.json', 'utf8'));
writeFileSync(plan.file, plan.content);
spawnSync('git', ['add', '--', plan.file]);
spawnSync('git', ['commit', '-qm', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`);
  const inbox: ManagerEvent[] = [],
    outcomes: GateOutcome[] = [];
  const queue = new SqliteLandingQueue(h.store.db, h.store);
  const job = new WorkerJob(h.tasks, queue, { deliver: (event) => inbox.push(event) });
  h.settings.gate = ['true'];
  const head = (ref = 'dev') => repositoryGit(h.root, 'rev-parse', ref);
  const ensureDev = () => {
    if (!repositoryGit(h.root, 'branch', '--list', 'dev')) repositoryGit(h.root, 'branch', 'dev', 'main');
  };
  function dispatch(
    file: string,
    after: string[] = [],
    // null leaves the command to the worker.
    acceptance: string[] | null = ['true'],
    goal = 'fixture',
    target?: 'main' | 'stabilize',
  ) {
    const briefFile = join(h.settings.stateDirectory, `brief-${crypto.randomUUID()}.md`);
    writeFileSync(
      briefFile,
      markdown
        .replace('goal: fixture', `goal: ${goal}${target ? `\ntarget: ${target}` : ''}`)
        .replace('paths: [result.txt]', `paths: [${file}]`)
        .replace('  command: [bun, test]\n', acceptance ? `  command: ${JSON.stringify(acceptance)}\n` : '')
        .replace('waiting: []', `waiting: []\nafter: ${JSON.stringify(after)}`),
    );
    const task = h.tasks.dispatch(briefFile);
    mkdirSync(dirname(join(task.worktree, file)), { recursive: true });
    mkdirSync(join(task.worktree, '.temp'), { recursive: true });
    writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content: file }));
    return task;
  }
  async function seed(file: string, after: string[] = [], acceptance = ['true']) {
    ensureDev();
    const task = dispatch(file, [], acceptance);
    repositoryGit(task.worktree, 'reset', '--hard', head());
    h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
      current.base = head();
    });
    await job.start(task.id);
    await job.drain();
    const commit = repositoryGit(task.worktree, 'rev-parse', 'HEAD');
    repositoryGit(h.root, 'update-ref', 'refs/heads/dev', commit, head());
    h.store.updateTask({ taskId: task.id, attempt: 1 }, (current) => {
      current.state = 'integrated';
      current.brief.after = after;
    });
    const entry = queue.next();
    if (entry) queue.acknowledge(entry.id);
    return h.store.task(task.id);
  }
  async function train(runGate?: GateRunner, deliver = true, runLaunchSmoke?: GateRunner) {
    await new MergeTrain({
      ...h.settings,
      queue,
      fence: h.store,
      sink: {
        onGateOutcome(outcome) {
          outcomes.push(outcome);
          if (deliver) job.onGateOutcome(outcome);
        },
      },
      ...(runGate ? { runGate } : {}),
      runLaunchSmoke:
        runLaunchSmoke ??
        (async (_command, cwd) => {
          const candidate = repositoryGit(cwd, 'rev-parse', 'HEAD');
          const devScriptTree = repositoryGit(cwd, 'rev-parse', 'refs/heads/dev');
          return {
            passed: true,
            output: `release evidence: candidate=${candidate} dev-script-tree=${devScriptTree} scenarios=test:passed lifecycle-regressions=test:passed\n`,
            timedOut: false,
          };
        }),
    }).run();
    await job.drain();
  }
  function advanceDev(file: string, content = file) {
    ensureDev();
    const tree = join(h.settings.stateDirectory, `dev-${crypto.randomUUID()}`);
    repositoryGit(h.root, 'worktree', 'add', '--detach', tree, 'dev');
    try {
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      writeFileSync(join(tree, file), content);
      repositoryGit(tree, 'add', '--', file);
      repositoryGit(tree, 'commit', '-qm', `Change ${file}`);
      repositoryGit(h.root, 'update-ref', 'refs/heads/dev', repositoryGit(tree, 'rev-parse', 'HEAD'), head());
    } finally {
      repositoryGit(h.root, 'worktree', 'remove', '--force', tree);
    }
    return head();
  }
  return {
    ...h,
    job,
    queue,
    inbox,
    outcomes,
    head,
    ensureDev,
    dispatch,
    seed,
    train,
    advanceDev,
    async start(task: Task) {
      await job.start(task.id);
      await job.drain();
    },
    async promote(runGate?: GateRunner) {
      const fallback = runGate ?? gateRunner(PROMOTION_GATE_TIMEOUT_MS);
      await promote({
        settings: h.settings,
        job,
        runGate: (command, cwd, logPath) => {
          // Most harness callbacks model the full promotion gate. Keep the newly added quick preflight independent;
          // tests for that preflight use promote() directly so their failure is observable.
          if (
            JSON.stringify(command) === JSON.stringify(['bun', 'scripts/typecheck.ts']) ||
            JSON.stringify(command) === JSON.stringify(['bun', 'run', '--cwd', 'packages/definitions', 'release'])
          )
            return Promise.resolve({ passed: true, output: '', timedOut: false });
          return fallback(command, cwd, logPath);
        },
      });
      await job.drain();
    },
  };
}
