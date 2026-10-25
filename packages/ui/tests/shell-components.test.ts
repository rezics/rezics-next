import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const components = join(import.meta.dir, '..', 'src', 'components');

// Modules that render nothing themselves, so they have no story of their own.
const helpers = ['avatar-initials', 'environment'];

test('the navigation and overlay components the app shell needs are ported with stories', () => {
  for (const name of ['bottom-navigation', 'breadcrumb', 'dialog', 'item', 'menu', 'sheet', 'sidebar', 'tooltip']) {
    expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
    expect(existsSync(join(components, `${name}.stories.tsx`)), `${name}.stories.tsx`).toBe(true);
  }
});

test('every component module has a story unless it is a declared helper', () => {
  const missing = readdirSync(components)
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.stories.tsx'))
    .map((file) => file.slice(0, -'.tsx'.length))
    .filter((name) => !helpers.includes(name) && !existsSync(join(components, `${name}.stories.tsx`)));
  expect(missing).toEqual([]);
  for (const name of helpers) expect(existsSync(join(components, `${name}.tsx`)), `${name}.tsx`).toBe(true);
});
