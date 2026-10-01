import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { devStackStopArgs, rememberDevStack, startedDevStacks, stopDevSession }
  from '../../../scripts/dev/stack-session.ts';
import { browserBudgets, browserFileCounts, browserProjectCount } from '../../../scripts/qa/browser-budget.ts';
import { selectTestCommand } from '../../../scripts/qa/test.ts';
import { commandAsync } from '../../../scripts/qa/core.ts';
import { cleanupQaStacks, forgetQaStack, QA_STACK_REGISTRY, rememberQaStack }
  from '../../../scripts/qa/stack-ownership.ts';

const root = resolve(import.meta.dir, '../../..');

test('QA resets every child stack after failure and retains failed resets for retry', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-ownership-'));
  try {
    const live = { profile: 'qa' as const, runId: 'title-test-l' };
    const restored = { profile: 'qa' as const, runId: 'title-test-r', persistent: true };
    rememberQaStack(live, directory);
    rememberQaStack(restored, directory);
    expect(() => rememberQaStack({ profile: 'dev' }, directory)).toThrow('only start QA');
    const resets: string[][] = [];
    const failed = await cleanupQaStacks(directory, async args => {
      resets.push(args);
      if (args.includes(live.runId)) throw new Error('Docker unavailable');
    });
    expect(resets).toEqual([
      ['--profile', 'qa', '--run-id', live.runId],
      ['--profile', 'qa', '--run-id', restored.runId, '--persistent'],
    ]);
    expect(failed).toEqual(['rezics-qa-title-test-l.json: Docker unavailable']);
    expect(readdirSync(directory)).toEqual(['rezics-qa-title-test-l.json']);
    expect(await cleanupQaStacks(directory, async () => {})).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
    rememberQaStack(live, directory);
    forgetQaStack(live, directory);
    expect(await cleanupQaStacks(directory, async () => { throw new Error('already reset'); })).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('QA timeout kills child setup processes and the runner still resets both recorded sites', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-timeout-'));
  const heartbeat = join(directory, 'heartbeat');
  try {
    const source = `import { rememberQaStack } from './scripts/qa/stack-ownership.ts';
      rememberQaStack({ profile: 'qa', runId: 'translation-test-l' });
      rememberQaStack({ profile: 'qa', runId: 'translation-test-r' });
      Bun.spawn([process.execPath, '-e', ${JSON.stringify(`import { appendFileSync } from 'node:fs';
        setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, '.'), 10);`)}],
        { stdout: 'inherit', stderr: 'inherit' });
      await Bun.sleep(10000);`;
    const result = await commandAsync(root, 'bun', ['-e', source], 500,
      { ...process.env, [QA_STACK_REGISTRY]: directory });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(existsSync(heartbeat)).toBe(true);
    const stopped = readFileSync(heartbeat, 'utf8');
    await Bun.sleep(50);
    expect(readFileSync(heartbeat, 'utf8')).toBe(stopped);
    const resets: string[] = [];
    expect(await cleanupQaStacks(directory, async args => { resets.push(args[3]!); })).toEqual([]);
    expect(resets).toEqual(['translation-test-l', 'translation-test-r']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('dev stop retains custom isolated backends until their cleanup succeeds', () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const checkout = mkdtempSync(join(root, '.temp', 'dev-session-test-'));
  try {
    expect(startedDevStacks(checkout)).toEqual([]);
    const disposable = { profile: 'qa' as const, runId: 'wt-other-id', accountsApp: true };
    const persistent = { profile: 'qa' as const, runId: 'wt-persistent', persistent: true };
    rememberDevStack(checkout, disposable);
    rememberDevStack(checkout, persistent);
    rememberDevStack(checkout, disposable);
    expect(startedDevStacks(checkout).map(stack => stack.runId).sort()).toEqual(['wt-other-id', 'wt-persistent']);
    expect(devStackStopArgs(startedDevStacks(checkout)[0]!)).toEqual(['down', '--remove-orphans']);
    expect(devStackStopArgs(disposable)).toEqual(['down', '--volumes', '--remove-orphans']);
    expect(() => stopDevSession(checkout, () => {}, () => { throw new Error('Docker unavailable'); }))
      .toThrow('Docker unavailable');
    // An interrupted cleanup has no forget call: the next stop still sees both.
    expect(startedDevStacks(checkout)).toHaveLength(2);
    const stopped: string[] = [];
    // No --backend argument: stop everything the session remembers, even if
    // AppHost never finished starting. Preserve the host failure for diagnosis.
    expect(() => stopDevSession(checkout, () => { throw new Error('AppHost absent'); },
      stack => { stopped.push(stack.runId!); })).toThrow('AppHost absent');
    expect(stopped.sort()).toEqual(['wt-other-id', 'wt-persistent']);
    expect(startedDevStacks(checkout)).toEqual([]);
    expect(() => rememberDevStack(checkout, { profile: 'dev' })).toThrow('Only isolated');
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('browser runners have independent budgets scaled to the selected files', () => {
  const small = browserBudgets(1, 1);
  const full = browserBudgets(18, 137);
  expect(small.playwright).toBe(300_000);
  expect(full.playwright).toBeGreaterThan(small.playwright);
  expect(full.storybook).toBeGreaterThan(180_000);
  expect(browserBudgets(1, 137).playwright).toBe(small.playwright);
  expect(browserBudgets(18, 1).storybook).toBe(small.storybook);
  expect(() => browserBudgets(0, 1)).toThrow('positive integers');
  // Each engine project repeats the files, so the Playwright budget grows with them.
  expect(browserBudgets(1, 1, 3).playwright).toBe(3 * small.playwright);
  expect([browserProjectCount(undefined), browserProjectCount('desktop-chrome'), browserProjectCount('a,b'), browserProjectCount('all')]).toEqual([1, 1, 2, 3]);
  const selected = browserFileCounts(root, ['apps/web/tests/work-page.e2e.ts']);
  expect(selected.playwright).toBe(1);
  expect(selected.storybook).toBeGreaterThan(1);
});

test('goalctl test routes explicit stories and tier runs to their owning runner', () => {
  expect(selectTestCommand(['apps/web/features/manage/members.stories.tsx', '-t', 'Give Role']))
    .toEqual(['task', ['storybook:test', '--', 'features/manage/members.stories.tsx', '-t', 'Give Role']]);
  expect(selectTestCommand(['apps/accounts/features/account/personal-info.stories.tsx'])[1][0])
    .toBe('accounts:storybook:test');
  expect(() => selectTestCommand(['apps/web/features/manage/members.stories.tsx',
    'apps/accounts/features/account/personal-info.stories.tsx'])).toThrow('separately');
  expect(selectTestCommand(['--tier', 'unit'])).toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'unit']]);
  expect(() => selectTestCommand(['--tier', 'made-up'])).toThrow();
});
