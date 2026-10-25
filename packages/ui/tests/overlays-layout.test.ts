import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const components = join(import.meta.dir, '..', 'src', 'components');

test('the overlays and layout helpers are ported with stories', () => {
  for (const name of [
    'drawer',
    'hover-card',
    'context-menu',
    'floating-panel',
    'tour',
    'resizable',
    'aspect-ratio',
    'float',
    'frame',
  ]) {
    expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
    expect(existsSync(join(components, `${name}.stories.tsx`)), `${name}.stories.tsx`).toBe(true);
  }
});
