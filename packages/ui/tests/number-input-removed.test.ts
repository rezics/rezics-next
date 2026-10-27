import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const ui = join(root, 'packages', 'ui');
const numberInputImport = /(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"]*number-input/;

type SourceReader = (path: string) => string;

function scanWorkspaceSources(rootDirectory: string, readSource: SourceReader = (path) => readFileSync(path, 'utf8')) {
  const excluded = new Set([
    'node_modules',
    '.temp',
    '.git',
    '.next',
    '.turbo',
    '.output',
    'dist',
    'build',
    'coverage',
    'paraglide',
  ]);
  const matches: string[] = [];

  for (const path of new Bun.Glob('**/src/**/*.{ts,tsx,js,jsx}').scanSync({ cwd: rootDirectory })) {
    if (path.split('/').some((part) => excluded.has(part))) continue;

    let source: string;
    try {
      source = readSource(join(rootDirectory, path));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }

    const lines = source.split('\n');
    for (const [index, line] of lines.entries()) {
      if (numberInputImport.test(line)) matches.push(`${path}:${index + 1}:${line}`);
    }
  }

  return matches;
}

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
  const matches = scanWorkspaceSources(root);
  expect(matches, matches.join('\n')).toEqual([]);
}, 120_000);

test('workspace source scan skips generated output and files removed while reading', () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const tempRoot = mkdtempSync(join(root, '.temp', 'number-input-source-scan-'));
  const generatedPath = join(tempRoot, 'apps', 'auth', 'src', 'paraglide', 'messages.ts');
  const removedPath = join(tempRoot, 'apps', 'auth', 'src', 'removed.ts');
  const ordinaryPath = join(tempRoot, 'packages', 'example', 'src', 'ordinary.ts');
  const ordinaryLine = "import NumberInput from '@rezics/ui/number-input';";

  try {
    for (const path of [generatedPath, removedPath, ordinaryPath]) {
      mkdirSync(dirname(path), { recursive: true });
    }
    writeFileSync(generatedPath, "import NumberInput from '@rezics/ui/number-input';\n");
    writeFileSync(removedPath, 'export const removed = true;\n');
    writeFileSync(ordinaryPath, `${ordinaryLine}\n`);

    let removedFileWasRead = false;
    const matches = scanWorkspaceSources(tempRoot, (path) => {
      if (path === removedPath) {
        removedFileWasRead = true;
        unlinkSync(path);
      }
      return readFileSync(path, 'utf8');
    });

    expect(removedFileWasRead).toBe(true);
    expect(matches).toEqual([`packages/example/src/ordinary.ts:1:${ordinaryLine}`]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
