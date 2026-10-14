import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript-6';

const root = resolve(import.meta.dir, '../../..');

test('outcome web readers import in Bun without initializing the Vite package registry', () => {
  const readers = new Set([
    resolve(root, 'apps/web/features/realm/realm-page.tsx'),
    resolve(root, 'apps/web/zones/official/index.ts'),
  ]);
  for (const file of new Bun.Glob('tests/qa/integration/outcomes/**/*.test.ts').scanSync({ cwd: root })) {
    const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const path = statement.moduleSpecifier.text;
      if (path.includes('apps/web/')) readers.add(resolve(root, dirname(file), path));
    }
  }
  expect(readers.size).toBeGreaterThan(2);
  // A fresh process cannot inherit the web unit suite's package-loader fixtures.
  const result = Bun.spawnSync({
    cmd: [process.execPath, '--eval', `for (const reader of ${JSON.stringify([...readers])}) await import(reader);`],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, `${result.stdout.toString()}${result.stderr.toString()}`).toBe(0);
});
