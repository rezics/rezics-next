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
  const result = Bun.spawnSync(
    [
      'git',
      'grep',
      '-n',
      '-E',
      '(from[[:space:]]*|import[[:space:]]*\\(|require[[:space:]]*\\()[[:space:]]*[\'"][^\'"]*number-input',
      '--',
      ':(glob)**/src/**/*.ts',
      ':(glob)**/src/**/*.tsx',
      ':(glob)**/src/**/*.js',
      ':(glob)**/src/**/*.jsx',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(1);
  expect(result.stdout.toString()).toBe('');
});
