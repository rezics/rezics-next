import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { devStackStopArgs, rememberDevStack, startedDevStacks, stopDevSession }
  from '../../../scripts/dev/stack-session.ts';
import { browserBudgets, browserFileCounts } from '../../../scripts/qa/browser-budget.ts';
import { selectTestCommand } from '../../../scripts/qa/test.ts';

const root = resolve(import.meta.dir, '../../..');

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
