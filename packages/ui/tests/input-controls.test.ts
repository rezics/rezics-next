import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const components = join(import.meta.dir, '..', 'src', 'components');

test('the input controls are ported with stories', () => {
  for (const name of [
    'number-input', 'slider', 'circular-slider', 'tags-input', 'input-otp', 'editable', 'toggle',
    'toggle-group', 'toggle-tooltip', 'autocomplete', 'listbox', 'signature-pad']) {
    expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
    expect(existsSync(join(components, `${name}.stories.tsx`)), `${name}.stories.tsx`).toBe(true);
  }
});
