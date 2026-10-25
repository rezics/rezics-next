import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = join(import.meta.dir, '..', 'src');

test('the website imports composition only through its package entry', () => {
  const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: source })];
  expect(files.length).toBeGreaterThan(10);
  const deep = files.flatMap((file) =>
    new Bun.Transpiler({ loader: file.endsWith('.tsx') ? 'tsx' : 'ts' })
      .scanImports(readFileSync(join(source, file), 'utf8'))
      .map((item) => item.path)
      .filter((path) => path.includes('packages/composition/'))
      .map((path) => `${file}: ${path}`),
  );
  expect(deep).toEqual([]);
});
