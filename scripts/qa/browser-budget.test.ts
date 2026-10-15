import { afterEach, expect, test } from 'bun:test';
import { browserApiOutcomeFiles, browserBudgets } from './browser-budget.ts';

const original = process.env.REZICS_E2E_PLAYWRIGHT_BUDGET_MS;
const originalApi = process.env.REZICS_E2E_API_OUTCOME_FILES;
afterEach(() => {
  if (original === undefined) delete process.env.REZICS_E2E_PLAYWRIGHT_BUDGET_MS;
  else process.env.REZICS_E2E_PLAYWRIGHT_BUDGET_MS = original;
  if (originalApi === undefined) delete process.env.REZICS_E2E_API_OUTCOME_FILES;
  else process.env.REZICS_E2E_API_OUTCOME_FILES = originalApi;
});
test('shared API outcome proofs use only explicit paths and one bounded preparation allowance', () => {
  delete process.env.REZICS_E2E_API_OUTCOME_FILES;
  const base = browserBudgets(1, 1);
  const files = ['tests/qa/integration/outcomes/realm/ranking.test.ts'];
  process.env.REZICS_E2E_API_OUTCOME_FILES = JSON.stringify(files);
  expect(browserApiOutcomeFiles()).toEqual(files);
  expect(browserBudgets(1, 1)).toEqual({ ...base, setup: base.setup + 600_000 });
  for (const value of [[], [...files, ...files], ['../ranking.test.ts'], ['services/main/tests/search.test.ts']])
    expect(() => browserApiOutcomeFiles(JSON.stringify(value))).toThrow();
});
test('ordinary browser runs retain their deadline', () => {
  delete process.env.REZICS_E2E_PLAYWRIGHT_BUDGET_MS;
  expect(browserBudgets(1, 1).playwright).toBe(300_000);
});
test('an explicit matrix deadline leaves startup and Storybook budgets unchanged', () => {
  const base = browserBudgets(1, 1);
  process.env.REZICS_E2E_PLAYWRIGHT_BUDGET_MS = '900000';
  expect(browserBudgets(1, 1)).toEqual({ ...base, playwright: 900_000 });
});
test('Accounts story and journey budgets stay out of a web-only allowance', () => {
  const web = browserBudgets(1, 1);
  expect(web.accountsPlaywright).toBe(0);
  expect(web.accountsStorybook).toBe(0);
  const withAccounts = browserBudgets(1, 1, 1, { playwright: 5, stories: 31 });
  expect(withAccounts.playwright).toBe(web.playwright);
  expect(withAccounts.storybook).toBe(web.storybook);
  expect(withAccounts.accountsPlaywright).toBeGreaterThan(web.playwright);
  expect(withAccounts.accountsStorybook).toBeGreaterThanOrEqual(180_000);
  expect(() => browserBudgets(1, 1, 1, { playwright: -1 })).toThrow('non-negative');
});
test('matrix deadlines reject invalid or unbounded values', () => {
  for (const value of ['0', '299999', '1800001', 'NaN', '900000.5']) {
    process.env.REZICS_E2E_PLAYWRIGHT_BUDGET_MS = value;
    expect(() => browserBudgets(1, 1)).toThrow();
  }
});
