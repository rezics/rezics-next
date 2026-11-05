import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const components = join(root, 'src', 'components');

test('useFormValue is a hook beside the other hooks, not a component module', async () => {
  expect(existsSync(join(components, 'form-value.tsx'))).toBe(false);
  const hook = await import(join(root, 'src', 'hooks', 'use-form-value.tsx'));
  expect(typeof hook.useFormValue).toBe('function');
});
