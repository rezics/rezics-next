import { expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';

// Check executable edges, including the barrel used by the installed useSession hook.
test('session composition and the shared reader capability have an acyclic runtime graph', async () => {
  const root = resolve(import.meta.dir, '../src');
  const files = [
    ...new Bun.Glob('reader/lifetime/*.{ts,tsx}').scanSync({ cwd: root }),
    ...['index', 'query', 'browser-state', 'observation'].map((name) => `session/${name}.ts`),
  ].map((file) => resolve(root, file));
  const transpiler = new Bun.Transpiler({ loader: 'tsx' });
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const imports = transpiler.scanImports(await Bun.file(file).text());
    graph.set(
      file,
      imports.flatMap(({ path }) => {
        if (!path.startsWith('.')) return [];
        const target = resolve(dirname(file), path);
        return files.filter(
          (candidate) => candidate === target || candidate === `${target}.ts` || candidate === `${target}.tsx`,
        );
      }),
    );
  }
  const visited = new Set<string>();
  function visit(file: string, stack: string[]) {
    expect(stack, `Runtime import cycle through ${file}`).not.toContain(file);
    if (visited.has(file)) return;
    for (const dependency of graph.get(file)!) visit(dependency, [...stack, file]);
    visited.add(file);
  }
  for (const file of files) visit(file, []);
  expect(transpiler.scanImports(await Bun.file(resolve(root, 'reader/lifetime/contract.ts')).text())).toEqual([]);
});
