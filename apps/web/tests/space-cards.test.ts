import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(app, path), 'utf8');

test('Space and Realm render their published subjects with the shared cover row and cards', () => {
  const space = read('src/community/space-page.tsx');
  expect(read('src/routes/spaces/$address.tsx')).toContain('<SpacePage');
  expect(read('src/routes/realms/$id.tsx')).toContain('<SpacePage');
  expect(space).toContain("from '@rezics/ui/cover-card'");
  expect(space).toContain('<CoverRow');
  expect(space).toContain('<CoverCard');
  expect(space).toContain('sharedRatio(');
  expect(space).toMatch(/secondary=/);
  expect(space).not.toMatch(/<Cover\s/);
});
