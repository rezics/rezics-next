import { afterAll, expect, test } from 'bun:test';
import { replaceModule } from '../module-replacement.ts';
import { state } from './state.ts';
const real = { ...(await import('./module.ts')) };
const restore = replaceModule(import.meta.resolve('./module.ts'), real, { read: () => 'first' });
afterAll(() => { restore(); state.cleanedUp = true; });
test('the first file uses its replacement', async () => {
  expect((await import('./module.ts')).read()).toBe('first');
});
