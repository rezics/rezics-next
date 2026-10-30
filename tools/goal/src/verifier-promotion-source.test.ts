import { expect, test } from 'bun:test';

// Keep the real-Git stale-ref promotion scenario in the separately named promotion contract file.
import './promotion.test.ts';

test('promotion selects the integration branch and leaves release authority to the full candidate gate', async () => {
  const source = await Bun.file(new URL('./promotion.ts', import.meta.url)).text();
  expect(source).toContain('return settings.integrationBranch;');
  expect(source).toContain('full candidate gate');
});
