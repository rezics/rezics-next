import { afterAll } from 'bun:test';

process.env.WEB_PERSONAL_DRIVER = new URL('./web-personal-driver.ts', import.meta.url).href;

// Bind every composed case to independent native factories with bounded, awaited cleanup.
afterAll(async () => {});
await import('../../../../specs/web-personal-outcomes.test.ts');
