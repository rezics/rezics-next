import { expect, test } from 'bun:test';

// Loading the coverage module merges every coverage/*.ts declaration and throws
// on a case declared twice, which otherwise surfaces only when a QA stack starts.
test('complete-case declarations merge without duplicates', async () => {
  await expect(import('../../../scripts/qa/coverage.ts')).resolves.toBeDefined();
});
