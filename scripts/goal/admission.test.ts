import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admissionCommand, assertWideRunAllowed, isWideRun, slotHolderLines, tryAcquireQaSlot } from './admission.ts';
import { acquireHeavy, withSlot } from './qa-slots.ts';
import { readDirectoryLease } from '../qa/process/lease.ts';
import { acquireQaSlots } from '../qa/core.ts';

const directories: string[] = [];
function fixture(): string {
  const directory = mkdtempSync(join(process.cwd(), '.temp', 'qa-admission-'));
  directories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const callers: [string, NodeJS.ProcessEnv, boolean][] = [
  ['worker', { GOAL_TASK_ID: 'worker', GOAL_ID: 'program' }, true],
  ['another manager', { GOAL_ID: 'catalogue' }, true],
  ['program', { GOAL_ID: 'program' }, false],
  ['terminal', {}, false],
];
const wideSelections = [[], ['--tier', 'unit'], ['--tier', 'e2e'], ['--tier', 'static'], ['--affected'], ['--affected=main'], ['--storybook', '--tier', 'e2e']];
const routes: [string, (args: string[]) => string[]][] = [
  ['goal test', args => admissionCommand(['--goalctl', 'test', ...args])],
  ['goal slot', args => admissionCommand(['--goalctl', 'slot', '--', 'bun', 'scripts/qa/cli.ts', ...args])],
  ['test', args => admissionCommand(['--', 'bun', 'scripts/qa/test.ts', ...args])],
  ['qa', args => admissionCommand(['--', 'bun', 'scripts/qa/cli.ts', ...args])],
  ['storybook', args => admissionCommand(['--', '../../node_modules/.bin/vitest', 'run', '--project', 'storybook', ...args])],
  ['accounts storybook', args => admissionCommand(['--', '../../node_modules/.bin/vitest', 'run', '--project', 'storybook', ...args])],
  ['web e2e', args => admissionCommand(['--', 'node_modules/.bin/playwright', 'test', '--config', 'apps/web/playwright.config.ts', ...args])],
  ['accounts e2e', args => admissionCommand(['--', 'node_modules/.bin/playwright', 'test', '--config', 'apps/accounts/playwright.config.ts', ...args])],
];

describe('wide admission on commands built for every entry point', () => {
  for (const [route, build] of routes) {
    for (const selection of wideSelections) {
      for (const [caller, env, refused] of callers) {
        test(`${route}: ${selection.join(' ') || 'suite'}: ${caller}`, () => {
          const command = build(selection);
          expect(isWideRun(command)).toBe(true);
          const run = () => assertWideRunAllowed(command, env);
          if (refused) expect(run).toThrow('run bun scripts/goal/goalctl.ts test <named test files> instead.');
          else expect(run).not.toThrow();
        });
      }
    }
    for (const file of ['scripts/goal/admission.test.ts', 'tests/qa/e2e/example.e2e.ts', 'features/example.stories.tsx']) {
      test(`${route}: a named ${file} is never wide, even with --heavy`, () => {
        const command = build(['--heavy', '--tier', 'e2e', '--file', file]);
        expect(isWideRun(command)).toBe(false);
        for (const [, env] of callers) expect(() => assertWideRunAllowed(command, env)).not.toThrow();
      });
    }
  }
  for (const [caller, env, refused] of callers) {
    test(`regress: ${caller}`, () => {
      const command = admissionCommand(['--goalctl', 'regress']);
      expect(isWideRun(command)).toBe(true);
      if (refused) expect(() => assertWideRunAllowed(command, env)).toThrow('Wide QA');
      else expect(() => assertWideRunAllowed(command, env)).not.toThrow();
    });
  }
  test('an affected preview is not a run', () => {
    for (const build of [routes[0]![1], routes[2]![1]]) {
      expect(isWideRun(build(['--affected', '--list']))).toBe(false);
      expect(() => assertWideRunAllowed(build(['--affected', '--list']), { GOAL_TASK_ID: 'worker' })).not.toThrow();
    }
  });
  test('slot commands that only mention QA words do not become test runs', () => {
    expect(isWideRun(['echo', 'qa', '--tier', 'unit'])).toBe(false);
    expect(isWideRun(['task', 'goal', '--', 'regress'])).toBe(true);
    expect(isWideRun(['task', 'goal', '--', 'regress', '--timing', 'a-run'])).toBe(false);
    expect(isWideRun(['task', 'goal', '--', 'test', '--affected=main'])).toBe(true);
  });
  test('Task entry points all use the admission adapter', () => {
    const taskfile = readFileSync('Taskfile.yml', 'utf8');
    for (const task of ['goal', 'test', 'qa', 'storybook:test', 'accounts:storybook:test', 'web:e2e', 'accounts:e2e']) {
      const stanza = taskfile.split(`\n  ${task}:\n`)[1]?.split(/\n  [a-z]/)[0];
      expect(stanza).toContain('scripts/goal/admission.ts');
    }
  });
});

test('the program waits for live workers before starting a wide command', async () => {
  const directory = fixture();
  let workers = ['catalogue'];
  let slept = 0;
  const messages: string[] = [];
  expect(await withSlot(['bun', 'scripts/qa/cli.ts', '--tier', 'unit'], false, undefined, {
    env: { GOAL_ID: 'program' }, slotDirectory: directory, workerGoals: () => workers,
    reap: () => {}, announce: message => messages.push(message), sleep: async () => { slept++; workers = []; },
    runCommand: async (_command, env, start) => {
      expect(slept).toBe(1);
      expect(readDirectoryLease(join(directory, 'heavy'))?.besideWorkers).toBe(0);
      expect(env.GOAL_QA_HEAVY_RUN).toBe('1');
      start();
      return 0;
    },
  })).toBe(0);
  expect(messages).toEqual(['waiting for 1 live worker before wide QA; use --beside-workers to start alongside them']);
});

test('--beside-workers records the live count and is stripped before dispatch; nested named batches reuse the lease', async () => {
  const directory = fixture();
  expect(await withSlot(['bun', 'scripts/qa/cli.ts', '--tier', 'unit', '--beside-workers'], false, undefined, {
    env: { GOAL_ID: 'program' }, slotDirectory: directory, workerGoals: () => ['a', 'a', 'b'], reap: () => {},
    sleep: async () => { throw new Error('unnecessary wait'); },
    runCommand: async (command, env, start) => {
      expect(command).not.toContain('--beside-workers');
      expect(readDirectoryLease(join(directory, 'heavy'))?.besideWorkers).toBe(3);
      start();
      const result = join(directory, 'batch.json');
      const code = await withSlot(['bun', 'scripts/qa/test.ts', 'scripts/goal/admission.test.ts'], true, result, {
        env, slotDirectory: directory, reap: () => { throw new Error('nested reap'); },
        runCommand: async (_batch, _env, batchStart) => { batchStart(); return 0; },
      });
      expect(JSON.parse(readFileSync(result, 'utf8')).code).toBe(0);
      return code;
    },
  })).toBe(0);
});

test('two program wide runs still serialize with --beside-workers', async () => {
  const directory = fixture();
  const lockDir = join(directory, 'heavy');
  const release = await acquireHeavy(['holder'], { lockDir, bindExit: false });
  let slept = false;
  try {
    const next = await acquireHeavy(['next'], { lockDir, bindExit: false, waitForWorkers: true, besideWorkers: true,
      workerGoals: () => ['a'], announce: () => {}, sleep: async () => { slept = true; release(); } });
    expect(slept).toBe(true);
    next();
  } finally { release(); }
});

function waiting(directory: string, goal: string): void {
  mkdirSync(join(directory, 'waiters'), { recursive: true });
  writeFileSync(join(directory, 'waiters', `${goal}.json`), JSON.stringify({ pid: process.pid, goal, waitingFor: 'slot' }));
}

for (const goals of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
  test(`ordinary share with ${goals.length} live Goals, contention, and spare capacity`, async () => {
    const directory = fixture();
    const total = 6;
    const share = Math.floor(total / goals.length);
    const env = { GOAL_ID: 'a', GOAL_TASK_ID: 'worker-a' };
    const held = [];
    try {
      for (let slot = 0; slot < Math.min(share, total - 1); slot++) {
        const lease = tryAcquireQaSlot(directory, total, slot, { env, workerGoals: () => goals });
        expect(lease).not.toBe('held');
        if (lease !== 'held') held.push(lease);
      }
      waiting(directory, 'b');
      if (goals.length > 1) {
        expect(tryAcquireQaSlot(directory, total, share, { env, workerGoals: () => goals })).toBe('held');
        const other = await acquireQaSlots(directory, 1, { GOAL_ID: 'b', GOAL_TASK_ID: 'worker-b', GOAL_QA_SLOTS: '6' }, process.pid,
          { inherit: false, workerGoals: () => goals });
        expect(other.count).toBe(1);
        other.release();
      }
      rmSync(join(directory, 'waiters', 'b.json'));
      const spare = tryAcquireQaSlot(directory, total, Math.min(share, total - 1), { env, workerGoals: () => goals });
      expect(spare).not.toBe('held');
      if (spare !== 'held') held.push(spare);
      expect(slotHolderLines(directory, total).every(line => line.includes('Goal a:') && line.includes('task worker-a'))).toBe(true);
    } finally { for (const lease of held) lease.release(); }
  });
}

test('each Goal has at least one slot and program admission is outside shares', () => {
  const directory = fixture();
  const goals = ['a', 'b', 'c'];
  waiting(directory, 'b');
  const first = tryAcquireQaSlot(directory, 2, 0, { env: { GOAL_ID: 'a' }, workerGoals: () => goals });
  expect(first).not.toBe('held');
  expect(tryAcquireQaSlot(directory, 2, 1, { env: { GOAL_ID: 'a' }, workerGoals: () => goals })).toBe('held');
  const program = tryAcquireQaSlot(directory, 2, 1, { env: { GOAL_ID: 'program' }, workerGoals: () => goals });
  expect(program).not.toBe('held');
  if (first !== 'held') first.release();
  if (program !== 'held') program.release();
});

test('ordinary dispatcher slots record their holder and --holders groups by Goal', async () => {
  const directory = fixture();
  const lines: string[] = [];
  await withSlot(['selected-command'], false, undefined, {
    slotDirectory: directory, slots: 2, env: { GOAL_ID: 'a', GOAL_TASK_ID: 'worker-a' }, workerGoals: () => ['a'], reap: () => {},
    runCommand: async () => {
      expect(readDirectoryLease(join(directory, '0'))?.task).toBe('worker-a');
      return withSlot(['--holders'], false, undefined, { slotDirectory: directory, slots: 2, announce: line => lines.push(line) });
    },
  });
  expect(lines).toEqual([`Goal a: slot 0, task worker-a (pid ${process.pid})`]);
});

for (const harness of [false, true]) {
  test(`${harness ? 'harness' : 'dispatcher'} waits at its share despite a free slot, then borrows when nobody else waits`, async () => {
    const directory = fixture();
    const env = { GOAL_ID: 'a', GOAL_TASK_ID: 'worker-a', GOAL_QA_SLOTS: '2' };
    const workerGoals = () => ['a', 'b'];
    const first = tryAcquireQaSlot(directory, 2, 0, { env, workerGoals });
    expect(first).not.toBe('held');
    waiting(directory, 'b');
    let slept = 0;
    const messages: string[] = [];
    const options = { workerGoals, announce: (message: string) => messages.push(message), sleep: async () => {
      slept++;
      expect(readDirectoryLease(join(directory, '1'))).toBeUndefined();
      rmSync(join(directory, 'waiters', 'b.json'));
    } };
    try {
      if (harness) {
        const slots = await acquireQaSlots(directory, 1, env, process.pid, { ...options, inherit: false });
        expect(slots.count).toBe(1);
        expect(readDirectoryLease(join(directory, '1'))?.task).toBe('worker-a');
        slots.release();
      } else {
        await withSlot(['selected-command'], false, undefined, { ...options, env, slotDirectory: directory, slots: 2,
          reap: () => {}, runCommand: async () => {
            expect(readDirectoryLease(join(directory, '1'))?.task).toBe('worker-a');
            return 0;
          } });
      }
      expect(slept).toBe(1);
      expect(messages[0]).toContain('Goal share');
      expect(readDirectoryLease(join(directory, '0'))?.task).toBe('worker-a');
    } finally { if (first !== 'held') first.release(); }
  });
}
