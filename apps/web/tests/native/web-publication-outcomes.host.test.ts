import { afterAll } from 'bun:test';

process.env.WEB_PUBLICATION_DRIVER = new URL('./web-publication-driver.ts', import.meta.url).href;

// The frozen suite closes each created driver in its afterEach hook, including
// when setup or an outcome assertion fails. Keep the suite lifecycle awaited so
// Bun runs those cleanup hooks before this wrapper completes.
afterAll(async () => {});

await import('../../../../specs/web-publication-outcomes.test.ts');
