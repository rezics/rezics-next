import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const src = resolve(import.meta.dir, '../../src');
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
      if (parents.has(next)) continue;
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

test('search work never loads the HTTP server', () => {
  const parents = closure(resolve(src, 'search/work.ts'));
  const server = resolve(src, 'server.ts');
  expect(parents.has(server) ? chain(parents, server) : null).toBeNull();
  expect(parents.has(resolve(src, 'search/runner.ts'))).toBe(true);
});

test('the outcome worker child decorates startWorker composition instead of a substitute module list', () => {
  const source = readFileSync(resolve(import.meta.dir, 'support/outcome-worker.ts'), 'utf8');
  expect(source).not.toContain('default-work-modules');
  expect(source).toContain('startWorker');
  expect(source).toMatch(/startWorker\([\s\S]*\(composed\)\s*=>/);
});

test('the erasure participant child decorates startWorker composition instead of a substitute module list', () => {
  const source = readFileSync(resolve(import.meta.dir, 'erasure-participant.test.ts'), 'utf8');
  expect(source).not.toMatch(/createKernelWorkModules\s*\(/);
  expect(source).toMatch(/startWorker\(readWorkerConfig\(params\),\s*\(defaults\)\s*=>/);
});
