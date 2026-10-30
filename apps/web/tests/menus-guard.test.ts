import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const source = resolve(import.meta.dir, '../src');

test('web source uses the responsive Menu component instead of importing shadcn dropdown or menu drawers', () => {
  const offending: string[] = [];
  for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: source })) {
    const text = Bun.file(resolve(source, file)).textSync();
    const importsDropdown = /from\s+['"][^'"]*shadcn\/dropdown-menu(?:\.tsx?)?['"]/.test(text);
    const importsMenuDrawer =
      /from\s+['"][^'"]*shadcn\/drawer(?:\.tsx?)?['"]/.test(text) &&
      (/aria-haspopup\s*=\s*['"]menu['"]/.test(text) || /data-menu|menuOpen|MenuOpen/.test(text));
    if (importsDropdown || importsMenuDrawer) offending.push(file);
  }
  expect(offending, `Direct menu primitives remain in: ${offending.join(', ')}`).toEqual([]);
});

test('following items use ListRow and keep their own menu control above the row link', async () => {
  const page = await Bun.file(resolve(source, 'library/mine-following-page.tsx')).text();
  expect(page).toContain("from '@rezics/ui/list-row'");
  expect(page).toContain('<ListRow');
  expect(page).toContain('<ListRowLink');
  expect(page).toContain('<ListRowControl');
  expect(page).toContain("from '@rezics/ui/menu'");
});

test('the subject Library slot uses shared responsive menus for its Collection actions', async () => {
  const page = await Bun.file(resolve(source, 'library/subject-slot-view.tsx')).text();
  expect(page).toContain("from '@rezics/ui/menu'");
  expect(page).not.toContain('<details');
  expect(page).toContain('Menu');
});
