import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { replaceModule } from './module-replacement.ts';

const real = { ...(await import('./module-replacement/delegates.ts')) };
const restore = replaceModule(import.meta.resolve('./module-replacement/delegates.ts'), real, {
  read(this: { prefix: string }, suffix: string) { return `fake:${this.prefix}${suffix}`; },
});
afterAll(restore);
const delegated = await import('./module-replacement/delegates.ts');

test('delegates retain arguments and this, preserve other exports, and reset to the snapshot', () => {
  const read = delegated.read;
  expect(read.call({ prefix: 'a' }, 'b')).toBe('fake:ab');
  expect(delegated.untouched).toBe(real.untouched);
  expect(delegated.value).toBe(real.value);
  restore.set({ read: suffix => `changed:${suffix}` });
  expect(read.call({ prefix: 'a' }, 'b')).toBe('changed:b');
  restore();
  expect(read.call({ prefix: 'a' }, 'b')).toBe('ab');
});

test('value exports and uninstalled delegates are refused without changing the table', () => {
  // Runtime callers cannot change a value even when they bypass the function-only type.
  expect(() => restore.set({ value: () => 'fake' } as never)).toThrow('real function export: value');
  expect(() => restore.set({ read: 'fake' } as never)).toThrow('real function export: read');
  expect(() => restore.set({ missing: () => 'fake' } as never)).toThrow('real function export: missing');
  expect(() => restore.set({ toString: () => 'fake' } as never)).toThrow('real function export: toString');
  expect(() => restore.set({ untouched: () => 'fake' })).toThrow('did not install a delegate for: untouched');
  expect(delegated.read.call({ prefix: 'a' }, 'b')).toBe('ab');
});

test('cleanup in the first file leaves later module replacements effective', () => {
  const fixtures = join(import.meta.dir, 'module-replacement');
  const result = spawnSync('task', ['goal:unit-files', '--',
    join(fixtures, 'first.fixture.ts'), join(fixtures, 'second.fixture.ts')], {
    cwd: join(import.meta.dir, '../../../..'), encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect({ status: result.status, output: result.status === 0 ? '' : result.stdout + result.stderr })
    .toEqual({ status: 0, output: '' });
});
