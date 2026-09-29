import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const ui = resolve(root, '../../packages/ui/src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.astro', 'tests'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.(astro|tsx?)$/.test(entry.name) ? [path] : [];
  });
}

/** UI files a source file reaches: `@rezics/ui/<name>` from the site, relative imports inside the package. */
function uiImports(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const found: string[] = [];
  for (const [, specifier] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    if (specifier!.startsWith('@rezics/ui/')) {
      const name = specifier!.slice('@rezics/ui/'.length);
      found.push(name === 'utils' ? join(ui, 'utils.ts') : join(ui, 'components', `${name}.tsx`));
    } else if (path.startsWith(ui) && specifier!.startsWith('.')) {
      const target = resolve(dirname(path), specifier!);
      if (existsSync(target)) found.push(target);
    }
  }
  return found;
}

test('styles.css scans exactly the Rezics UI sources the site reaches', () => {
  const reached = new Set<string>();
  const visit = (path: string) => {
    if (reached.has(path) || !existsSync(path)) return;
    reached.add(path);
    for (const next of uiImports(path)) visit(next);
  };
  for (const path of files(join(root, 'src'))) for (const next of uiImports(path)) visit(next);
  const css = readFileSync(join(root, 'src/styles/global.css'), 'utf8');
  const scanned = [...css.matchAll(/@source "([^"]+)";/g)].map(([, path]) =>
    resolve(root, 'src/styles', path!),
  );
  expect(scanned.map((path) => relative(ui, path)).sort()).toEqual(
    [...reached].map((path) => relative(ui, path)).sort(),
  );
});

test('the logo red never carries text', () => {
  // Brand rule (packages/ui/src/styles.css): --brand is for marks; text and filled buttons use --primary.
  for (const path of files(join(root, 'src'))) {
    const source = readFileSync(path, 'utf8');
    expect(source, path).not.toMatch(
      /\btext-brand\b|\bdecoration-brand\b|text-\[var\(--brand\)\]|color:\s*var\(--brand\)/,
    );
    for (const [, classes] of source.matchAll(/class(?:Name)?="([^"]*\bbg-brand\b[^"]*)"/g))
      expect(classes, path).not.toMatch(/\btext-/);
  }
});
