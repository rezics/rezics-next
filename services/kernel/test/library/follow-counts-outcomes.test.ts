import { expect, test } from 'bun:test';

const location = new URL('./support/follow-counts-driver.ts', import.meta.url);
process.env.FOLLOW_COUNTS_DRIVER = location.href;
await import('../../../../specs/follow-counts-outcomes.test.ts');

test('Follow acceptance binds the native factory by its actual file URL', async () => {
  expect(process.env.FOLLOW_COUNTS_DRIVER).toBe(location.href);
  expect(typeof (await import('./support/follow-counts-driver.ts')).createFollowCountsDriver).toBe('function');
});
