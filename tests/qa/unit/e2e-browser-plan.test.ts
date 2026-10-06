import { expect, test } from 'bun:test';
import { e2eBrowserPlan, storybookCommands } from '../../../scripts/qa/browser-budget.ts';
import { parseArgs } from '../../../scripts/qa/core.ts';

const journey = 'apps/web/tests/public-search.e2e.ts';

test('selected journey files skip Storybook', () => {
  const selected = e2eBrowserPlan([journey, '--grep', 'search']);
  expect(selected.stories).toBe(false);
  expect(selected.storySkipReason).toBe('selected journey files');
  expect(selected.accountsJourneys).toBe(false);
  expect(selected.selectedFiles).toEqual([journey]);
  expect(storybookCommands(selected)).toEqual([]);
});

test('a full e2e tier runs web and Accounts stories once each', () => {
  for (const args of [[], ['--grep', 'search']] as const) {
    const plan = e2eBrowserPlan(args);
    expect(plan.stories).toBe(true);
    expect(plan.storySkipReason).toBeUndefined();
    expect(plan.accountsJourneys).toBe(true);
    expect(storybookCommands(plan)).toEqual([
      { name: 'storybook', root: 'apps/web' },
      { name: 'accounts-storybook', root: 'apps/accounts' },
    ]);
  }
});

test('an explicit storybook request runs both suites for a selected journey', () => {
  const requested = e2eBrowserPlan([journey], true);
  expect(requested.stories).toBe(true);
  expect(requested.accountsJourneys).toBe(false);
  expect(storybookCommands(requested).map(step => step.root)).toEqual(['apps/web', 'apps/accounts']);
  expect(parseArgs(['--tier', 'e2e', '--file', journey, '--storybook']).storybook).toBe(true);
  expect(() => parseArgs(['--tier', 'integration', '--storybook'])).toThrow('--storybook requires the e2e tier');
});
