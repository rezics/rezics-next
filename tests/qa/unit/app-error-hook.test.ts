import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

/** Chained `.error(` is an Elysia hook. `console.error(` is not. */
function localErrorHookKinds(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const found: string[] = [];
  if (/(?:^|[^.\w])\.error\s*\(/.test(code)) found.push('.error(');
  if (/\bonError\b/.test(code)) found.push('onError');
  if (/error\s*:\s*\(\s*\{/.test(code)) found.push('error:');
  return found;
}

function mountedRouteModules(): string[] {
  const app = readFileSync(join(root, 'services/main/src/app.ts'), 'utf8');
  return [...new Set([...app.matchAll(/from '\.\/routes\/([^']+\.ts)'/g)].map(match => match[1]!))].sort();
}

test('the local-hook scan sees an Elysia error hook and ignores logging', () => {
  expect(localErrorHookKinds('new Elysia().error(({ error }) => error)')).toEqual(['.error(']);
  expect(localErrorHookKinds('socket.onError(() => undefined)')).toEqual(['onError']);
  expect(localErrorHookKinds('error: ({ error }) => undefined')).toEqual(['error:']);
  expect(localErrorHookKinds('console.error(JSON.stringify({ error: error.message }))')).toEqual([]);
  expect(localErrorHookKinds('// .error(() => undefined)\nconst error = 1')).toEqual([]);
});

test('route modules mounted in createMainApp declare no local error hook', () => {
  const modules = mountedRouteModules();
  expect(modules).toContain('wiki.ts');
  expect(modules).toContain('library-imports.ts');
  expect(modules).toContain('search.ts');
  const offenders = modules.flatMap(module => {
    const source = readFileSync(join(root, 'services/main/src/routes', module), 'utf8');
    const kinds = localErrorHookKinds(source);
    return kinds.length ? [`${module}: ${kinds.join(', ')}`] : [];
  });
  expect(offenders).toEqual([]);
});
