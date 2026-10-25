import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const components = join(import.meta.dir, '..', 'src', 'components');

test('field and select are ported with stories', () => {
  for (const name of ['field', 'select']) {
    expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
    expect(existsSync(join(components, `${name}.stories.tsx`)), `${name}.stories.tsx`).toBe(true);
  }
});

test('ChoiceSelect offers a short list of choices', async () => {
  const select = await import(join(components, 'select.tsx'));
  expect(typeof select.ChoiceSelect).toBe('function');
});
