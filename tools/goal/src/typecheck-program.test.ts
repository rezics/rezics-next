import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const goalRoot = resolve(import.meta.dir, '..');
const repository = resolve(goalRoot, '../..');
const SPECIFIER = /(?:from\s+|import\(\s*)['"]([^'"]+)['"]/g;
const SQL_MODULE = /(?:from\s+|import\(\s*)['"][^'"]+\.sql['"]/;
const PRODUCT = /^(services|apps|packages)\//;

function resolveImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
}

function programFiles(): string[] {
  const roots = [
    ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: goalRoot }),
    ...new Bun.Glob('test-support/**/*.ts').scanSync({ cwd: goalRoot }),
    'scripts/test-timings.ts',
    'scripts/test-timings.test.ts',
  ];
  const seen = new Set<string>();
  const queue = roots.map((path) => resolve(goalRoot, path));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const next = resolveImport(file, match[1]!);
      if (next) queue.push(next);
    }
  }
  return [...seen].map((file) => relative(repository, file)).sort();
}

test('the tools/goal typecheck program does not include database-backed product sources', () => {
  const files = programFiles();
  expect(files).toContain('scripts/compiler-database.ts');
  expect(files).toContain('scripts/typecheck.ts');
  const sqlBacked = files.filter((file) => {
    if (!PRODUCT.test(file)) return false;
    if (file.endsWith('.sql')) return true;
    return SQL_MODULE.test(readFileSync(resolve(repository, file), 'utf8'));
  });
  expect(sqlBacked).toEqual([]);
});
