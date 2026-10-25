import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const components = join(import.meta.dir, '..', 'src', 'components');

test('the feedback, overlay and disclosure components are ported with stories', () => {
  for (const name of [
    'accordion',
    'action-bar',
    'alert-dialog',
    'carousel',
    'collapsible',
    'popover',
    'progress',
    'table',
    'tabs',
    'toast',
  ]) {
    expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
    expect(existsSync(join(components, `${name}.stories.tsx`)), `${name}.stories.tsx`).toBe(true);
  }
});
