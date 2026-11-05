import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { operatorEntry } from './operator-entry.ts';
import { screenshotExecution } from './screenshots.ts';

test('operator screenshots accept a chosen external directory and every capture selector', () => {
  const out = resolve(import.meta.dir, '../../../../operator review');
  const plan = screenshotExecution(
    ['--operator', '--story', 'pages-space--*', '--locale', 'ja', '--theme', 'dark', '--width', '390', '--out', out],
    {},
    () => false,
  );
  expect(plan.operator).toBe(true);
  expect(plan.args).not.toContain('--operator');
  expect(plan.options).toMatchObject({
    stories: ['pages-space--*'],
    locales: ['ja'],
    themes: ['dark'],
    widths: [390],
    out,
  });
  expect(() => screenshotExecution(['--out', out], {}, () => false)).toThrow('inside the candidate workspace');
  const worker = screenshotExecution(['--out', '.temp/review shots'], { GOAL_TASK_ID: 'worker' }, () => false);
  expect(worker.operator).toBe(false);
  expect(worker.returned).toBe('.temp/review shots');
});

test('operator mode cannot bypass worker, test-runtime or physical check-host admission', () => {
  for (const env of [{ GOAL_TASK_ID: 'worker' }, { REZICS_TEST_RUNTIME: '1' }]) {
    expect(() => operatorEntry(['--operator'], env, () => false)).toThrow('outside worker checks');
  }
  expect(() => operatorEntry(['--operator'], {}, () => true)).toThrow('outside worker checks');
  expect(operatorEntry(['--port', '6007'], { GOAL_TASK_ID: 'worker' }, () => true)).toEqual({
    operator: false,
    args: ['--port', '6007'],
  });
});

test('the root command catalogue describes every required wrapper and shares the service environment', () => {
  const taskfile = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../../../Taskfile.yml'), 'utf8')) as {
    dotenv: string[];
    tasks: Record<string, { desc: string; cmds?: string[]; deps?: string[] }>;
  };
  expect(taskfile.dotenv).toContain('.temp/goal/goal.env');
  const required = [
    'dev',
    'storybook',
    'storybook:build',
    'screenshots',
    'typecheck',
    'test',
    'seed:cross-media',
    'goal:service:install',
    'goal:service:status',
    'goal:service:restart',
    'goal:service:logs',
    'goal:cp-sync',
  ];
  for (const name of required) expect(taskfile.tasks[name]?.desc.length, name).toBeGreaterThan(0);
  for (const task of Object.values(taskfile.tasks)) expect(task.desc.length).toBeGreaterThan(0);
  for (const name of ['storybook', 'storybook:build', 'screenshots']) {
    expect(taskfile.tasks[name]!.cmds?.[0]).toContain(`bun run --cwd apps/web ${name} --operator`);
  }
});
