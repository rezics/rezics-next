import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const src = resolve(import.meta.dir, '../src');
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });

/** Each relative runtime import reachable from `start`, mapped to the file that first imports it. */
function closure(start: string): Map<string, string | null> {
  const parents = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (!path.startsWith('.') || !path.endsWith('.ts')) continue;
      const next = resolve(dirname(file), path);
      if (parents.has(next) || !existsSync(next)) continue;
      parents.set(next, file);
      queue.push(next);
    }
  }
  return parents;
}

function chain(parents: Map<string, string | null>, file: string): string {
  const files = [file];
  for (let at = parents.get(file); at; at = parents.get(at)) files.unshift(at);
  return files.map((entry) => relative(src, entry)).join(' -> ');
}

test('the kernel worker never loads the HTTP server', () => {
  const parents = closure(resolve(src, 'worker.ts'));
  const server = resolve(src, 'server.ts');
  expect(parents.has(server) ? chain(parents, server) : null).toBeNull();
  expect(parents.has(resolve(src, 'composition/work-modules.ts'))).toBe(true);
  expect(parents.has(resolve(src, 'composition/content.ts'))).toBe(true);
  expect(parents.has(resolve(src, 'composition/community.ts'))).toBe(true);
  expect(chain(parents, resolve(src, 'content/register.ts'))).toContain('composition/work-modules.ts');
  expect(chain(parents, resolve(src, 'community/declaration.ts'))).toContain('composition/work-modules.ts');
});
