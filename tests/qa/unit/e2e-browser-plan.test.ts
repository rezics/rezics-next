import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { e2eBrowserPlan, storybookCommands } from '../../../scripts/qa/browser-budget.ts';
import { parseArgs } from '../../../scripts/qa/core.ts';
import { measuredBrowserStep, type BrowserStepResult } from '../../../scripts/qa/e2e.ts';
import { GiB, waitForMemory } from '../../../scripts/qa/memory-admission.ts';

const root = resolve(import.meta.dir, '../../..');

test('browser admission can outlast a step budget and execution still receives the full budget', async () => {
  let now = 0, started = false;
  const result = await measuredBrowserStep('Playwright', 50, async budget => {
    expect(now).toBe(120);
    expect(budget).toBe(50);
    started = true;
    now += budget;
  }, { root, env: { REZICS_STACK_PROFILE: 'qa' }, deadline: 500, now: () => now,
    admission: (need, options) => waitForMemory(need, { ...options, pollMs: 60, announce: () => {},
      sleep: async ms => { expect(started).toBe(false); now += ms; },
      read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: (now < 120 ? 11 : 12) * GiB }),
    }) });
  expect(result).toMatchObject({ budgetMs: 50, elapsedMs: 50, admissionWaitMs: 120, passed: true });
});

test('browser admission expires at the run deadline without launching or charging step execution', async () => {
  let now = 0, started = false;
  const records: BrowserStepResult[] = [];
  await expect(measuredBrowserStep('Storybook', 10, async () => { started = true; }, {
    root, env: { REZICS_STACK_PROFILE: 'qa' }, deadline: 70, now: () => now, record: result => records.push(result),
    admission: (need, options) => waitForMemory(need, { ...options, pollMs: 50, announce: () => {},
      sleep: async ms => { now += ms; },
      read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: 11 * GiB }),
    }),
  })).rejects.toThrow('Memory admission deadline reached');
  expect(now).toBe(70);
  expect(started).toBe(false);
  expect(records[0]).toMatchObject({ budgetMs: 10, elapsedMs: 0, admissionWaitMs: 70, passed: false });
});

test('saved non-QA browser contexts bypass reserve calculation despite Goal metadata', async () => {
  let now = 0;
  const result = await measuredBrowserStep('Storybook', 10, async () => { now += 10; }, {
    root, env: { REZICS_STACK_PROFILE: 'prod', GOAL_TASK_ID: 'G-1234', REZICS_QA_HOST_RESERVE_GIB: 'invalid' },
    deadline: -1, now: () => now, admission: async () => { throw new Error('Unexpected QA admission'); },
  });
  expect(result).toMatchObject({ elapsedMs: 10, admissionWaitMs: 0, passed: true });
});

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
