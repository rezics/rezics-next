import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from './cli.ts';
import { git } from './merge.ts';
import { integrationHarness, markdown } from './test-support.ts';

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

async function controlPlaneOutcome(
  baseFails: boolean | string[],
  files = ['tools/goal/src/fixtures/environment-probe.test.ts'],
  baseFiles = files,
) {
  const h = integrationHarness();
  try {
    for (const file of baseFiles) {
      mkdirSync(join(h.root, dirname(file)), { recursive: true });
      writeFileSync(join(h.root, file), '// fixture test file on base\n');
    }
    if (baseFiles.length) {
      git(h.root, 'add', '--', ...baseFiles);
      git(h.root, 'commit', '-m', 'Add base test fixtures');
    }
    h.ensureDev();
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
    const output = files.map((file) => `FAIL ${file}\n`).join('');
    const commands: { command: string[]; cwd: string }[] = [];
    await h.train(async (command, cwd) => {
      commands.push({ command: [...command], cwd });
      if (JSON.stringify(command) === JSON.stringify(['bun', 'test', '--timeout', '30000', 'tools/goal/src']))
        return { passed: false, output, timedOut: false };
      const file = command.at(-1)!;
      if (command[0] === 'bun' && command[1] === 'test' && files.includes(file)) {
        const onBase = cwd.includes('control-plane-base-');
        const baseFileFails = Array.isArray(baseFails) ? baseFails.includes(file) : baseFails;
        const fails = onBase ? baseFileFails : true;
        return { passed: !fails, output: fails ? `FAIL ${file}\n` : '', timedOut: false };
      }
      return { passed: true, output: '', timedOut: false };
    });
    return { outcome: h.outcomes[0], commands };
  } finally {
    h.dispose();
  }
}

test.serial(
  'the control-plane gate allows failures reproduced by the same test file on its base',
  async () => {
    const { outcome } = await controlPlaneOutcome(true);
    expect(outcome?.passed).toBe(true);
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

test.serial(
  "the control-plane landing check reruns each failing test file alone on the landing's base and refuses only failures that pass on the base or are new in the branch",
  async () => {
    const shared = 'tools/goal/src/fixtures/shared.test.ts';
    const regression = 'tools/goal/src/fixtures/regression.test.ts';
    const added = 'tools/goal/src/fixtures/new.test.ts';
    const { outcome, commands } = await controlPlaneOutcome(
      [shared],
      [shared, regression, added],
      [shared, regression],
    );
    const baseRuns = commands.filter(
      ({ command, cwd }) => command[1] === 'test' && cwd.includes('control-plane-base-'),
    );
    expect(baseRuns.map(({ command }) => command)).toEqual([
      ['bun', 'test', '--timeout', '30000', regression],
      ['bun', 'test', '--timeout', '30000', shared],
    ]);
    expect(outcome?.passed).toBe(false);
    expect(outcome?.firstFailure?.excerpt).toContain(regression);
    expect(outcome?.firstFailure?.excerpt).toContain(added);
    expect(outcome?.firstFailure?.excerpt).not.toContain(shared);
  },
  30_000,
);

test.serial(
  'the control-plane gate refuses a test file that fails on the branch and passes on its base',
  async () => {
    const { outcome } = await controlPlaneOutcome(false);
    expect(outcome?.passed).toBe(false);
    expect(outcome?.firstFailure?.assertion).toContain('Failures introduced on this branch');
  },
  30_000,
);

test.serial(
  'the control-plane gate compares each failing test file alone on branch and base',
  async () => {
    const files = ['tools/goal/src/fixtures/one.test.ts', 'tools/goal/src/fixtures/two.test.ts'];
    const { outcome, commands } = await controlPlaneOutcome([files[0]!], files);
    const isolatedRuns = commands.filter(
      ({ command }) => command[0] === 'bun' && command[1] === 'test' && files.includes(command.at(-1)!),
    );

    expect(isolatedRuns.map(({ command }) => command)).toEqual([
      ['bun', 'test', '--timeout', '30000', files[0]!],
      ['bun', 'test', '--timeout', '30000', files[1]!],
      ['bun', 'test', '--timeout', '30000', files[0]!],
      ['bun', 'test', '--timeout', '30000', files[1]!],
    ]);
    expect(isolatedRuns[0]?.cwd).not.toContain('control-plane-base-');
    expect(isolatedRuns[1]?.cwd).not.toContain('control-plane-base-');
    expect(isolatedRuns[2]?.cwd).toContain('control-plane-base-');
    expect(isolatedRuns[3]?.cwd).toContain('control-plane-base-');
    expect(outcome?.passed).toBe(false);
    expect(outcome?.firstFailure?.excerpt).toContain(files[1]);
    expect(outcome?.firstFailure?.excerpt).not.toContain(files[0]);
  },
  30_000,
);

test.serial(
  'a failing control-plane test file added on the branch is a new failure',
  async () => {
    const file = 'tools/goal/src/fixtures/branch-only.test.ts';
    const { outcome, commands } = await controlPlaneOutcome([], [file], []);
    const isolatedRuns = commands.filter(
      ({ command }) => JSON.stringify(command) === JSON.stringify(['bun', 'test', '--timeout', '30000', file]),
    );

    expect(isolatedRuns.map(({ command }) => command)).toEqual([['bun', 'test', '--timeout', '30000', file]]);
    expect(isolatedRuns[0]?.cwd).not.toContain('control-plane-base-');
    expect(outcome?.passed).toBe(false);
    expect(outcome?.firstFailure?.assertion).toContain('Failures introduced on this branch');
  },
  30_000,
);
