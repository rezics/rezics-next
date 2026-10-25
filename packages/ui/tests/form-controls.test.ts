import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const components = join(root, 'src', 'components');

test('the form controls are ported with stories', () => {
  for (const name of ['button-group', 'checkbox', 'clipboard', 'combobox', 'command', 'file-upload', 'image-cropper',
    'input-group', 'native-select', 'password-input', 'qr-code', 'radio-group', 'rating', 'segment-group', 'switch',
    'textarea']) {
    expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
    expect(existsSync(join(components, `${name}.stories.tsx`)), `${name}.stories.tsx`).toBe(true);
  }
});

test('useFormValue is a hook beside the other hooks, not a component module', async () => {
  expect(existsSync(join(components, 'form-value.tsx'))).toBe(false);
  const hook = await import(join(root, 'src', 'hooks', 'use-form-value.tsx'));
  expect(typeof hook.useFormValue).toBe('function');
});

test('the field story shows the ported controls instead of native stand-ins', () => {
  const story = readFileSync(join(components, 'field.stories.tsx'), 'utf8');
  for (const name of ['checkbox', 'switch', 'textarea']) expect(story).toContain(`from './${name}.tsx'`);
  expect(story).not.toMatch(/<input\b[^>]*type="checkbox"/);
  expect(story).not.toMatch(/<textarea\b/);
});
