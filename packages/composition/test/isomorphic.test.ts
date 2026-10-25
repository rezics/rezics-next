import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

const root = join(import.meta.dir, '..');
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function reachable(file: string, graph = new Map<string, string[]>()): Map<string, string[]> {
  if (graph.has(file)) return graph;
  const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(readFileSync(file, 'utf8'));
  const specifiers = imports.map((item) => item.path);
  graph.set(file, specifiers);
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) reachable(resolve(dirname(file), specifier), graph);
  }
  return graph;
}

test('the package entry reaches no Node built-in module', () => {
  const graph = reachable(join(root, 'src', 'index.ts'));
  expect(graph.size).toBeGreaterThan(5);
  const found = [...graph].flatMap(([file, specifiers]) =>
    specifiers
      .filter((specifier) => specifier.startsWith('node:') || builtins.has(specifier))
      .map((specifier) => `${relative(root, file)}: ${specifier}`),
  );
  expect(found).toEqual([]);
});
