import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './cli.ts';
import { createRuntime } from './config.ts';
import { git } from './merge.ts';
import { openDb } from './db.ts';
import { harness, integrationHarness, markdown } from './test-support.ts';

function cliRuntimeFixture() {
  const h = harness();
  const databasePath = join(h.settings.stateDirectory, 'control-plane-cli.sqlite');
  const create = (options?: { trainMode: 'detached' | 'inline' }) => {
    const runtime = createRuntime({
      settings: h.settings,
      ...(options ? { trainMode: options.trainMode } : {}),
      db: openDb(databasePath),
    });
    runtime.db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    runtime.db
      .query('INSERT OR IGNORE INTO manager_sessions(id, state) VALUES (?, ?)')
      .run('fixture-manager', JSON.stringify({}));
    runtime.train.runWaiting = async () => {};
    return runtime;
  };
  const managerDecision = () => {
    const db = openDb(databasePath);
    try {
      return db.query('SELECT manager FROM manager_turn_decisions WHERE manager = ?').get('fixture-manager');
    } finally {
      db.close();
    }
  };
  return { h, create, managerDecision };
}

async function withEnvironment<T>(values: Record<string, string | undefined>, runTest: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await runTest();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function controlPlaneOutcome(suiteOutput: string, suiteTimedOut = false, baseFailureFile?: string) {
  const h = integrationHarness();
  try {
    if (baseFailureFile) {
      mkdirSync(join(h.root, 'tools/goal/src/fixtures'), { recursive: true });
      writeFileSync(join(h.root, baseFailureFile), '// fixture test file on main\n');
      git(h.root, 'add', '--', baseFailureFile);
      git(h.root, 'commit', '-m', 'Add main failure fixture');
    }
    h.ensureDev();
    const mainBefore = h.head('main');
    const devBefore = h.head('dev');
    const brief = join(h.settings.stateDirectory, 'control-plane.md');
    writeFileSync(
      brief,
      markdown
        .replace('goal: fixture', 'goal: control-plane')
        .replace('paths: [result.txt]', 'paths: [tools/goal/src/change.ts]')
        .replace('command: [bun, test]', 'command: ["true"]'),
    );
    const task = h.tasks.dispatch(brief);
    mkdirSync(join(task.worktree, 'tools/goal/src'), { recursive: true });
    writeFileSync(join(task.worktree, 'tools/goal/src/change.ts'), 'change');
    mkdirSync(join(task.worktree, '.temp'), { recursive: true });
    writeFileSync(
      join(task.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: 'tools/goal/src/change.ts', content: 'change' }),
    );
    await h.start(task);
    const commands: { command: string[]; cwd: string }[] = [];
    await h.train(async (command, cwd) => {
      commands.push({ command: [...command], cwd });
      if (JSON.stringify(command) === JSON.stringify(['bun', 'test', '--timeout', '30000', 'tools/goal/src']))
        return { passed: false, output: suiteOutput, timedOut: suiteTimedOut };
      return { passed: true, output: '', timedOut: false };
    });
    return {
      outcome: h.outcomes[0],
      commands,
      mainBefore,
      devBefore,
      mainAfter: h.head('main'),
      devAfter: h.head('dev'),
    };
  } finally {
    h.dispose();
  }
}

test('run() passes detached train mode to its runtime factory without changing the process environment', async () => {
  const before = process.env.GOAL_TRAIN_MODE;
  const fixture = cliRuntimeFixture();
  delete process.env.GOAL_TRAIN_MODE;
  let received: { trainMode: 'detached' | 'inline' } | undefined;
  try {
    const status = await withEnvironment({ GOAL_MANAGER: 'fixture-manager' }, () =>
      run(['status'], (options) => {
        received = options;
        return fixture.create(options);
      }),
    );
    expect(status).toBe(0);
    expect(received).toEqual({ trainMode: 'detached' });
    expect(process.env.GOAL_TRAIN_MODE).toBeUndefined();
    expect(fixture.managerDecision()).toBeTruthy();
  } finally {
    if (before === undefined) delete process.env.GOAL_TRAIN_MODE;
    else process.env.GOAL_TRAIN_MODE = before;
    fixture.h.dispose();
  }
});

test.serial(
  'run() selects train mode explicitly and attributes manager commands in SQLite without changing env',
  async () => {
    const before = process.env.GOAL_TRAIN_MODE;
    const fixture = cliRuntimeFixture();
    const received: unknown[] = [];
    try {
      await withEnvironment({ GOAL_MANAGER: 'fixture-manager' }, async () => {
        for (const command of ['status', 'train', 'status']) {
          expect(
            await run([command], (options) => {
              received.push(options);
              return fixture.create(options);
            }),
          ).toBe(0);
          expect(process.env.GOAL_TRAIN_MODE).toBe(before);
        }
      });
      expect(received).toEqual([{ trainMode: 'detached' }, { trainMode: 'inline' }, { trainMode: 'detached' }]);
      expect(fixture.managerDecision()).toBeTruthy();
    } finally {
      fixture.h.dispose();
    }
  },
);

test.serial(
  'a required full-suite failure is refused even when the same test failure exists on main',
  async () => {
    const failureFile = 'tools/goal/src/fixtures/base-regression.test.ts';
    const { outcome, commands, mainBefore, devBefore, mainAfter, devAfter } = await controlPlaneOutcome(
      `FAIL ${failureFile}\n`,
      false,
      failureFile,
    );
    expect(outcome?.passed).toBe(false);
    expect(outcome?.stage).toBe('gate');
    expect(outcome?.firstFailure?.excerpt).toContain(failureFile);
    expect(commands.some(({ command }) => command[1] === 'test' && command.at(-1) === failureFile)).toBe(false);
    expect(commands.some(({ cwd }) => cwd.includes('control-plane-base-'))).toBe(false);
    expect(mainAfter).toBe(mainBefore);
    expect(devAfter).toBe(devBefore);
  },
  30_000,
);
