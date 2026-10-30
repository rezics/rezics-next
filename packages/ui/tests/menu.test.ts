import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('package menus share the responsive menu implementation', () => {
  const menu = read('src/components/menu.tsx');
  expect(menu).toContain('export function Menu');
  expect(menu).toContain('BottomSheet');
  expect(menu).not.toMatch(/shadcn\/drawer/);
  expect(menu).toContain('DropdownMenu');
  expect(menu).toContain('window.matchMedia');
  expect(menu).toContain('(max-width: 767px)');
  expect(menu).toContain('(pointer: coarse)');
  expect(menu).toContain('history.pushState');
  expect(menu).toContain('popstate');
  expect(menu).toContain('closeOnNavigation');
  expect(menu).toContain('onClickCapture={closeAfterNavigation}');
  expect(menu).toContain('focus');
  expect(menu).toMatch(/type: 'link'/);
  expect(menu).toContain("'destructive'");

  for (const component of [
    'item-menu.tsx',
    'content-actions.tsx',
    'cover-card.tsx',
    'reactions.tsx',
    'selection-bar.tsx',
    'shelf-list.tsx',
    'shelf-toolbar.tsx',
  ]) {
    const source = read(`src/components/${component}`);
    expect(source, component).not.toMatch(/from ['"](?:@rezics\/ui\/)?(?:\.\.\/)*shadcn\/dropdown-menu/);
    expect(source, component).toMatch(/from ['"].*menu/);
  }
});

test('the menu story demonstrates sheet and dropdown states in both themes', () => {
  const story = read('src/components/menu.stories.tsx');
  for (const state of ['PlainEntries', 'SubmenuPage', 'RadioEntries', 'DestructiveEntry', 'DesktopDropdown'])
    expect(story).toContain(state);
  expect(story).toContain('dark');
  expect(story).toContain('390');
  expect(story).toContain('1280');
});

test('menu callers document device, history, selection and destructive behaviour', () => {
  const readme = read('README.md');
  expect(readme).toMatch(/## Menu/);
  expect(readme).toContain('bottom sheet');
  expect(readme).toContain('browser Back');
  expect(readme).toContain('destructive');
  expect(readme).toContain('editor-selection-menu.tsx');
  expect(readme).toContain('cover.tsx');
});
