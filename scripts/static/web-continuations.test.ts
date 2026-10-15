import { expect, test } from 'bun:test';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedContinuationGroups, continuationInventory, webSources } from './web-continuations.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const accepted = JSON.parse(readFileSync(new URL('./web-continuations.inventory.json', import.meta.url), 'utf8'));
const source = (text: string, path = 'apps/web/features/example/read.ts') => ({ path, source: text });
const forwarded = 'export async function page(api, cursor) { const page = await api.get({ query: { cursor, limit: 20 } }); return { items: page.items, nextCursor: page.nextCursor }; }';

test('production web projection syntax introduces no new violations', async () => {
  expect(changedContinuationGroups(continuationInventory(await webSources(root)), accepted.violations)).toEqual([]);
});

test.each([forwarded, `// A benign edit.\n${forwarded}`,
  forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'return page;'),
  forwarded.replace('cursor, limit', 'cursor: cursor ?? undefined, limit'),
])('direct opaque forwarding needs no exception: %s', text => {
  expect(continuationInventory([source(text)])).toEqual([]);
});

test.each([
  forwarded.replace('nextCursor: page.nextCursor', 'nextCursor: null'),
  forwarded.replace('page.nextCursor', 'other.nextCursor'),
  forwarded.replace('cursor, limit', 'cursor: Number(cursor) + 20, limit'),
  forwarded.replace('const page =', 'cursor += 20; const page ='),
  forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'return page.items;'),
  forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'const {items,nextCursor} = page; return {items,nextCursor};'),
  forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'const ignored = page.nextCursor; return page.items;'),
  forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'delete page.nextCursor; return page;'),
  forwarded.replace('const page =', 'const seek = Number(cursor) + 20; const page =').replace('cursor, limit', 'cursor: seek, limit'),
])('planted drops, mutations and uncertain alias flows fail: %s', text => {
  expect(continuationInventory([source(text)]).length).toBeGreaterThan(0);
});

test('an exact expression exception cannot cover another projection in the same file', () => {
  const text = 'export function read(page) { return page.items; }';
  const baseline = continuationInventory([source(text)]);
  expect(changedContinuationGroups(continuationInventory([source(`${text}\nexport function another(other) { return other.items; }`)]), baseline)).toHaveLength(1);
});


test('stories stay outside production inventory', () => {
  expect(continuationInventory([source('api.get().items', 'apps/web/features/example/read.stories.tsx')])).toEqual([]);
});

test('a capped-request exception does not survive a changed cap or alias initializer', () => {
  const text = 'export function read(api) { const page = api.get({limit:1}); return page.items; }';
  const baseline = continuationInventory([source(text)]);
  expect(changedContinuationGroups(continuationInventory([source(text.replace('limit:1', 'limit:100'))]), baseline)).toHaveLength(1);
  expect(changedContinuationGroups(continuationInventory([source(`// trivia\n${text}`)]), baseline)).toEqual([]);
});

const cursorPaths = ['apps/web/features/api/page.ts', 'apps/web/features/library/import-api.ts',
  'apps/web/features/zone-editor/navigation-read.test.ts'];
function missingCursorProbes(rule: string): string[] {
  const directory = mkdtempSync(join(root, '.temp/cursor-scope-'));
  try {
    mkdirSync(join(directory, 'rules'));
    writeFileSync(join(directory, 'sgconfig.yml'), 'ruleDirs: [rules]\n');
    writeFileSync(join(directory, 'rules/cursor.yml'), rule);
    const paths = cursorPaths.flatMap(path => [path, path.replace(/\.ts$/, '.tsx')]);
    for (const path of paths) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), 'api.get({ query: { cursor: index + 1 } });');
    }
    const result = spawnSync(join(root, 'node_modules/.bin/ast-grep'), ['scan', '--json'], {
      cwd: directory, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(1);
    const found = new Set((JSON.parse(result.stdout) as { file: string }[]).map(row => row.file.replace(/^\.\//, '')));
    return paths.filter(path => !found.has(path));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('cursor arithmetic is checked in every formerly excluded TS and TSX file', () => {
  const rule = readFileSync(new URL('./ast-grep/rules/no-cursor-arithmetic.yml', import.meta.url), 'utf8');
  expect(missingCursorProbes(rule)).toEqual([]);
  const excluded = rule.replaceAll('severity: error', 'ignores:\n  - apps/web/features/library/import-api.ts\nseverity: error');
  expect(missingCursorProbes(excluded)).toContain('apps/web/features/library/import-api.ts');
});
