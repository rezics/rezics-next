import { afterAll, expect, test } from 'bun:test';
import { replaceModule } from '../module-replacement.ts';
import { state } from './state.ts';
const real = { ...(await import('./module.ts')) };
const restore = replaceModule(import.meta.resolve('./module.ts'), real, { read: () => 'second' });
afterAll(restore);
expect(state.cleanedUp).toBe(true);
const { consume } = await import('./consumer.ts');
test('a consumer first loaded after cleanup uses the second replacement', () => {
  expect(consume()).toBe('second');
});
