import { afterAll } from 'bun:test';

process.env.WEB_PERSONAL_DRIVER = new URL('./web-personal-driver.ts', import.meta.url).href;

// Keep the original 23 cases, independent beforeEach factories, 180-second
// bounds and awaited afterEach cleanup. No report parser can turn a red into a pass.
afterAll(async () => {});
await import('../../../../specs/web-personal-outcomes.test.ts');
