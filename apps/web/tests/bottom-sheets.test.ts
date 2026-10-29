import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const read = (path: string) => readFile(join(root, path), 'utf8');

test('all phone sheets use the shared bottom sheet and no consumer imports the shadcn drawer', async () => {
  const [search, progress, copies, menu, bottomSheet] = await Promise.all([
    read('apps/web/src/search/search.tsx'),
    read('apps/web/src/library/progress-session.tsx'),
    read('apps/web/src/library/copies-page.tsx'),
    read('packages/ui/src/components/menu.tsx'),
    read('packages/ui/src/components/bottom-sheet.tsx'),
  ]);
  for (const source of [search, progress, copies, menu]) {
    expect(source).toContain('BottomSheet');
    expect(source).not.toContain('@rezics/ui/shadcn/drawer');
  }
  expect(bottomSheet).toContain('showSwipeHandle');
  expect(bottomSheet).toContain('env(safe-area-inset-bottom)');
  expect(bottomSheet).toContain('DrawerClose');
});

test('the mobile search filter is directly after the query form with an outline icon button', async () => {
  const source = await read('apps/web/src/search/search.tsx');
  expect(source).toContain('SlidersHorizontalIcon');
  expect(source).toContain("variant: 'outline'");
  expect(source).toContain('w-fit');
  expect(source).not.toContain('order-first');
  expect(source).toContain('m.search_filters()');
});

test('the shared component renders the required title, close control and before slot', async () => {
  const source = await read('packages/ui/src/components/bottom-sheet.tsx');
  expect(source).toContain('before');
  expect(source).toContain('DrawerTitle');
  expect(source).toContain('min-h-11');
  expect(source).toContain('closeLabel');
});
