import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

export function temporaryDirectory(): { path: string; close(): void } {
  const root = resolve(import.meta.dir, '../../../.temp/goal-tests');
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, 'case-'));
  return { path, close: () => rmSync(path, { recursive: true, force: true }) };
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
  return {
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
): { root: string; settings: Settings; store: WorkerStore; tasks: WorkerTasks; briefFile: string; dispose(): void } {
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
  writeFileSync(command, script.replaceAll('__GOAL_TEST_DATABASE_PATH__', JSON.stringify(join(state, 'goal.sqlite'))));
  chmodSync(command, 0o755);
  const pool = { ...fixturePool(join(state, 'account')), command };
  writeFileSync(join(state, 'local.json'), JSON.stringify({ version: 1, terminationGraceMs: 1000, pools: [pool] }));
  const settings = loadSettings({ cwd: root, env: {} });
  settings.integrationChecks = [];
  mkdirSync(settings.stateDirectory, { recursive: true });
  const store = new WorkerStore(openDb(join(settings.stateDirectory, 'goal.sqlite'))),
    tasks = new WorkerTasks(settings, store);
  const briefFile = join(state, 'source.md');
  writeFileSync(briefFile, markdown);
  return {
    root,
    settings,
    store,
    tasks,
    briefFile,
    dispose() {
      store.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
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
  function dispatch(file: string, after: string[] = [], acceptance = ['true'], goal = 'fixture') {
    const briefFile = join(h.settings.stateDirectory, `brief-${crypto.randomUUID()}.md`);
    writeFileSync(
      briefFile,
      markdown
        .replace('goal: fixture', `goal: ${goal}`)
        .replace('paths: [result.txt]', `paths: [${file}]`)
        .replace('command: [bun, test]', `command: ${JSON.stringify(acceptance)}`)
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
