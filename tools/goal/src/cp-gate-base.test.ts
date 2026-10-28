import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './cli.ts';
import { MergeTrain } from './merge-train.ts';
import { integrationHarness, markdown } from './test-support.ts';

test('run() passes detached train mode to its runtime factory without changing the process environment', async () => {
  const before = process.env.GOAL_TRAIN_MODE;
  delete process.env.GOAL_TRAIN_MODE;
  let received: { trainMode: 'detached' | 'inline' } | undefined;
  try {
    const status = await run(['status'], async (options) => {
      received = options;
      return {
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

async function controlPlaneOutcome(baseFails: boolean) {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const brief = join(h.settings.stateDirectory, 'control-plane.md');
    writeFileSync(brief, markdown
      .replace('goal: fixture', 'goal: control-plane')
      .replace('paths: [result.txt]', 'paths: [tools/goal/src/change.ts]'));
    const task = h.tasks.dispatch(brief);
    mkdirSync(join(task.worktree, 'tools/goal/src'), { recursive: true });
    writeFileSync(join(task.worktree, 'tools/goal/src/change.ts'), 'change');
    mkdirSync(join(task.worktree, '.temp'), { recursive: true });
    writeFileSync(join(task.worktree, '.temp/worker-plan.json'), '{}');
    await h.start(task);
    const file = 'tools/goal/src/fixtures/environment-probe.test.ts';
    const output = `FAIL ${file}\n`;
    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: { onGateOutcome(outcome) { h.outcomes.push(outcome); h.job.onGateOutcome(outcome); } },
      runGate: async (command, cwd) => {
        if (JSON.stringify(command) === JSON.stringify(['bun', 'test', 'tools/goal/src']))
          return { passed: false, output, timedOut: false };
        if (JSON.stringify(command) === JSON.stringify(['bun', 'test', file])) {
          const onBase = cwd.includes('control-plane-base-');
          return { passed: onBase ? !baseFails : false, output: onBase && !baseFails ? '' : output, timedOut: false };
        }
        return { passed: true, output: '', timedOut: false };
      },
    }).run();
    return h.outcomes[0];
  } finally { h.dispose(); }
}

test('the control-plane gate allows failures reproduced by the same test file on its base', async () => {
  const outcome = await controlPlaneOutcome(true);
  expect(outcome?.passed).toBe(true);
});

test('the control-plane gate refuses a test file that fails on the branch and passes on its base', async () => {
  const outcome = await controlPlaneOutcome(false);
  expect(outcome?.passed).toBe(false);
  expect(outcome?.firstFailure?.assertion).toContain('Failures introduced on this branch');
});
