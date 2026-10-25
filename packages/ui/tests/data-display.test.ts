import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const components = join(import.meta.dir, '..', 'src', 'components');

test('the data display components are ported with stories', () => {
  for (const name of [
    'data-list', 'pagination', 'steps', 'tree-view', 'json-tree-view', 'circular-progress', 'timer',
    'marquee', 'swap', 'highlight', 'hint', 'announcement', 'format']) {
    expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
    expect(existsSync(join(components, `${name}.stories.tsx`)), `${name}.stories.tsx`).toBe(true);
  }
});
