import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

function sources(directory: string): string[] {
  return [...new Bun.Glob('**/*.ts').scanSync({ cwd: resolve(root, directory), absolute: true })].sort();
}

test('kernel source imports shared Auth types only from the contract', () => {
  const violations: string[] = [];
  for (const file of sources('services/kernel/src')) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /\b(?:import|export)\s+(?:[^;'"()]*?\s+from\s*)?(['"])(@rezics\/auth(?:\/[^'"]*)?)\1/g,
    )) {
      if (match[2] !== '@rezics/auth/membership-workflows' || /\btype\b/.test(match[0]))
        violations.push(`${file}: ${match[0]}`);
    }
    for (const match of source.matchAll(/\bimport\s*\(\s*(['"])(@rezics\/auth(?:\/[^'"]*)?)\1\s*\)/g))
      violations.push(`${file}: ${match[0]}`);
  }
  expect(violations).toEqual([]);
});

test('the Auth contract has only type declarations and no runtime values or dependencies', () => {
  const files = sources('packages/auth-contract/src');
  expect(files.length).toBeGreaterThan(0);
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    expect(transpiler.transformSync(source).trim()).toBe('');
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\b(?:const|let|var|function|class|enum|namespace|import)\b/);
  }
  const manifest = JSON.parse(readFileSync(resolve(root, 'packages/auth-contract/package.json'), 'utf8'));
  expect(manifest.name).toBe('@rezics/auth-contract');
  expect(manifest.private).toBe(true);
  expect(manifest.exports).toBe('./src/index.ts');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
    expect(Object.keys(manifest[field] ?? {})).toEqual([]);
});
