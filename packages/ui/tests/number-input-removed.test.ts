import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const ui = join(root, 'packages', 'ui');

test('the legacy number input and its existence test are removed', () => {
  for (const path of [
    'src/components/number-input.tsx',
    'src/components/number-input.stories.tsx',
    'tests/input-controls.test.ts',
  ]) {
    expect(existsSync(join(ui, path)), path).toBe(false);
  }
  const manifest = JSON.parse(readFileSync(join(ui, 'package.json'), 'utf8'));
  expect(manifest.exports['./number-input']).toBeUndefined();
  expect(readFileSync(join(ui, 'src/index.ts'), 'utf8')).not.toContain('number-input');
  expect(readFileSync(join(ui, 'README.md'), 'utf8')).not.toContain('number-input');
});

test('workspace sources do not import the legacy number input', () => {
  const excluded = new Set(['node_modules', '.temp', '.git', '.next', '.turbo', 'dist', 'build', 'coverage']);
  const pattern = /(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"]*number-input/;
  const matches: string[] = [];

  for (const path of new Bun.Glob('**/src/**/*.{ts,tsx,js,jsx}').scanSync({ cwd: root })) {
    if (path.split('/').some((part) => excluded.has(part))) continue;
    const lines = readFileSync(join(root, path), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (pattern.test(line)) matches.push(`${path}:${index + 1}:${line}`);
    }
  }

  expect(matches, matches.join('\n')).toEqual([]);
}, 120_000);
