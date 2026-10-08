import { expect, test } from 'bun:test';
import { PRIVATE_SEARCH_REQUEST_MS, PrivateSearchBudgetExceeded,
  withPrivateSearchBudget }
  from '../../../services/main/src/modules/contribution/search-private.ts';

test('SEARCH10: private read that never settles ends at the typed wall deadline', async () => {
  const started = performance.now();
  await expect(withPrivateSearchBudget(() => new Promise<never>(() => {})))
    .rejects.toBeInstanceOf(PrivateSearchBudgetExceeded);
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(PRIVATE_SEARCH_REQUEST_MS - 25);
  expect(elapsed).toBeLessThan(PRIVATE_SEARCH_REQUEST_MS + 500);
});

test('SEARCH10: private Fuseki call count rejects an invalid budget before reading', async () => {
  let called = false;
  await expect(withPrivateSearchBudget(async () => {
    called = true;
  }, 13)).rejects.toBeInstanceOf(PrivateSearchBudgetExceeded);
  expect(called).toBe(false);
});
