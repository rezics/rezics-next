import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './cli.ts';
import { git } from './merge.ts';
import { integrationHarness, markdown } from './test-support.ts';

async function controlPlaneOutcome(
  suiteOutput: string,
  suiteTimedOut = false,
  baseFailureFile?: string,
) {
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
    return { outcome: h.outcomes[0], commands, mainBefore, devBefore, mainAfter: h.head('main'), devAfter: h.head('dev') };
  } finally {
    h.dispose();
  }
}

test('run() passes detached train mode to its runtime factory without changing the process environment', async () => {
  const before = process.env.GOAL_TRAIN_MODE;
  delete process.env.GOAL_TRAIN_MODE;
  let received: { trainMode: 'detached' | 'inline' } | undefined;
  try {
    const status = await run(['status'], async (options) => {
      received = options;
      return {
        settings: { stateDirectory: '/tmp/goal-cli-test' },
        db: { close() {} },
        store: { tasks: () => [] },
        job: { drain: async () => {} },
        managerSocket: '/missing',
      } as never;
    });
    expect(status).toBe(0);
    expect(received).toEqual({ trainMode: 'detached' });
    expect(process.env.GOAL_TRAIN_MODE).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.GOAL_TRAIN_MODE;
    else process.env.GOAL_TRAIN_MODE = before;
  }
});

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

test('run() passes the detached train mode to the code that needs it instead of setting process.env', async () => {
  const before = process.env.GOAL_TRAIN_MODE;
  const received: unknown[] = [];
  const runtime = {
    settings: { stateDirectory: '.temp/goal-cli-test' },
    db: { close() {} },
    store: { tasks: () => [] },
    job: { drain: async () => {} },
    inbox: {},
    queue: {},
    train: { runWaiting: async () => {} },
  };
  for (const command of ['status', 'train', 'status']) {
    expect(
      await run([command], (options) => {
        received.push(options);
        return runtime as never;
      }),
    ).toBe(0);
    expect(process.env.GOAL_TRAIN_MODE).toBe(before);
  }
  expect(received).toEqual([{ trainMode: 'detached' }, { trainMode: 'inline' }, { trainMode: 'detached' }]);
});
