import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { indexedFiles, indexedSource, indexedSql } from './repo-index.ts';
import { cruiseDependencies } from '../static/mechanism-dependencies.ts';

function withTree(run: (root: string) => void) {
  const directory = resolve(import.meta.dir, '../../.temp');
  mkdirSync(directory, { recursive: true });
  const root = mkdtempSync(join(directory, 'repo-index-test-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('repository syntax facts reuse content and invalidate edits, additions and deletions', () => {
  withTree((root) => {
    writeFileSync(join(root, 'a.ts'), 'export const first = 1;');
    const first = indexedFiles(root, ['.']);
    expect(indexedFiles(root, ['.'])).toBe(first);
    writeFileSync(join(root, 'a.ts'), 'export const other = 2;');
    expect(indexedFiles(root, ['.'])['a.ts']!.text).toContain('other');
    // A lazy read of the old index must retain its own bytes after replacement.
    expect(first['a.ts']!.ast.type).toBe('Program');
    expect(JSON.stringify(first['a.ts']!.ast)).toContain('first');
    expect(first['a.ts']!.text).toContain('first');
    writeFileSync(join(root, 'b.ts'), 'export const added = 3;');
    expect(indexedFiles(root, ['.'])['b.ts']).toBeDefined();
    rmSync(join(root, 'b.ts'));
    expect(indexedFiles(root, ['.'])['b.ts']).toBeUndefined();
  });
});

test('in-memory facts retain Unicode source and content-specific syntax', () => {
  const source = { file: 'unicode.tsx', text: 'const 名 = "界"; const view = <div>{名}</div>;' };
  const first = indexedSource(source);
  expect(first.text).toBe(source.text);
  expect(indexedSource(source)).toBe(first);
  expect(indexedSource({ ...source, text: 'const changed = 1;' }).text).toContain('changed');
});

test('import resolution invalidates when TypeScript path configuration changes', () => {
  withTree((root) => {
    writeFileSync(join(root, 'first.ts'), 'export const value = 1;');
    writeFileSync(join(root, 'second.ts'), 'export const value = 2;');
    writeFileSync(join(root, 'caller.ts'), 'import { value } from "@owner";');
    const configure = (target: string) =>
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@owner': [target] } } }),
      );
    configure('./first.ts');
    expect(indexedFiles(root, ['.'])['caller.ts']!.imports[0]!.resolved).toBe('first.ts');
    configure('./second.ts');
    expect(indexedFiles(root, ['.'])['caller.ts']!.imports[0]!.resolved).toBe('second.ts');
  });
});

test('JavaScript string facts preserve lone UTF-16 surrogates', () => {
  const facts = indexedSource({ file: 'surrogate.ts', text: 'const value = "\\ud800";' });
  expect(JSON.stringify(facts.ast)).toContain('\\ud800');
});

test('import rules preserve type-only edges and follow dynamic imports and reexports', () => {
  withTree((root) => {
    mkdirSync(join(root, 'owner'));
    writeFileSync(
      join(root, 'owner/internal.ts'),
      'export type Shape = {}; export const secret = 1;',
    );
    writeFileSync(join(root, 'typed.ts'), 'import { type Shape } from "./owner/internal.ts";');
    writeFileSync(
      join(root, 'runtime.ts'),
      'export { secret } from "./owner/internal.ts"; import("./owner/internal.ts");',
    );
    const config = {
      forbidden: [
        {
          name: 'runtime-boundary',
          from: { path: '' },
          to: { path: 'owner/internal', dependencyTypesNot: ['type-only'] },
        },
      ],
    };
    const findings = cruiseDependencies(root, config, ['.']);
    expect(findings.other).toEqual([
      { importer: 'runtime.ts', imported: 'owner/internal.ts', rule: 'runtime-boundary' },
    ]);
    writeFileSync(join(root, 'typed.ts'), 'import { Shape, secret } from "./owner/internal.ts";');
    expect(cruiseDependencies(root, config, ['.']).other).toHaveLength(2);
  });
});

test('SQL facts come from PostgreSQL parsing and retain qualified relation positions', () => {
  const text = 'SELECT r.value FROM "owner"."records" r WHERE r.value = $1';
  const facts = indexedSql(text);
  expect(facts.parseError).toBeUndefined();
  expect(facts.tree).toBeDefined();
  expect(facts.references).toContainEqual({
    relation: 'owner.records',
    offset: text.indexOf('"owner"'),
  });
  expect(indexedSql(text)).toBe(facts);
});

test('invalid executable syntax fails rather than yielding an incomplete index', () => {
  expect(() => indexedSource({ file: 'invalid.ts', text: 'export const = ;' })).toThrow();
});
