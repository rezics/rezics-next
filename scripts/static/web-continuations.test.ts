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
}, 60_000);

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
  forwarded.replace('nextCursor: page.nextCursor }', 'nextCursor: page.nextCursor, ...other }'),
  forwarded.replace('nextCursor: page.nextCursor }', 'nextCursor: page.nextCursor, nextCursor: null }'),
  forwarded.replace('const page =', 'const seek = Number(cursor) + 20; const page =').replace('cursor, limit', 'cursor: seek, limit'),
])('planted drops, mutations and uncertain alias flows fail: %s', text => {
  expect(continuationInventory([source(text)]).length).toBeGreaterThan(0);
});

test('an exact expression exception cannot cover another projection in the same file', () => {
  const text = 'export function read(page) { return page.items; }';
  const baseline = continuationInventory([source(text)]);
  expect(changedContinuationGroups(continuationInventory([source(`${text}\nexport function another(other) { return other.items; }`)]), baseline)).toHaveLength(1);
});

// These readers consume a URL token. Keep each exception pinned to its whole reader.
test.each([
  ['apps/web/features/realm/discussions-route.tsx', 'cursor: parseCursor(search)', 'cursor: parseCursor(search) + "suffix"'],
  ['apps/web/features/realm/ranking-recorded-page.tsx', "params.get('cursor') ?? undefined", "Number(params.get('cursor')) + 1"],
] as const)('a reviewed Realm URL exception rejects changed data flow: %s / %s', (path, before, after) => {
  const original = readFileSync(join(root, path), 'utf8');
  expect(original).toContain(before);
  expect(changedContinuationGroups(continuationInventory([source(original, path)]), accepted.violations)).toEqual([]);
  expect(changedContinuationGroups(continuationInventory([source(original.replace(before, after), path)]), accepted.violations).length)
    .toBeGreaterThan(0);
});

// Studio's renderer receives a page and its navigation separately. Its count
// traversal consumes every parent/cursor or explicitly reports a lower bound.
// These exact exceptions must stop applying when either flow changes.
test.each([
  ['apps/web/features/studio/counts.ts', 'if (page.nextCursor) pending.push', 'if (false) pending.push'],
  ['apps/web/features/studio/counts.ts', 'maxPages = 20', 'maxPages = 1'],
  ['apps/web/features/studio/read.ts', 'page: { ...page.data, items }', 'page: { ...page.data, items, nextCursor: null }'],
  ['apps/web/features/studio/studio-home.tsx', '{moreHref ? <Link', '{false ? <Link'],
  ['apps/web/app/[locale]/studio/[agent]/page.tsx', 'validCursor(query.cursor)', 'validCursor(query.cursor + "suffix")'],
] as const)('Studio continuation evidence rejects dropped traversal or navigation: %s / %s', (path, before, after) => {
  const original = readFileSync(join(root, path), 'utf8');
  expect(original).toContain(before);
  expect(changedContinuationGroups(continuationInventory([source(original, path)]), accepted.violations)).toEqual([]);
  expect(changedContinuationGroups(continuationInventory([source(original.replace(before, after), path)]), accepted.violations).length)
    .toBeGreaterThan(0);
});


test('stories stay outside production inventory', () => {
  expect(continuationInventory([source('api.get().items', 'apps/web/features/example/read.stories.tsx')])).toEqual([]);
});

const completeBatch = `export function read(pages) {
  for (const page of pages) {
    if (!page.ok || page.data.nextCursor) continue;
    for (const item of page.data.items) consume(item);
  }
}`;

test('a card batch can iterate only after refusing an unfinished page', () => {
  expect(continuationInventory([source(completeBatch)])).toEqual([]);
});

test.each([
  completeBatch.replace('page.data.nextCursor', 'other.data.nextCursor'),
  completeBatch.replace('|| page.data.nextCursor', '&& page.data.nextCursor'),
  completeBatch.replace('page.data.nextCursor', '!page.data.nextCursor'),
  completeBatch.replace('continue;', 'observe(page);'),
  completeBatch.replace('for (const item', 'page.data = other; for (const item'),
])('an unfinished card batch cannot bypass the continuation guard: %s', text => {
  expect(continuationInventory([source(text)]).length).toBeGreaterThan(0);
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

const browseLink = `import { browseHref } from './browse-state.ts';
export function pageModel(base, state, page) { return { items: page.items,
  next: page.nextCursor ? browseHref(base, { ...state, cursor: page.nextCursor }) : null }; }`;
const browseSource = (text: string) => source(text, 'apps/web/features/zones/example.ts');

test('the imported browse encoder carries a sibling page continuation into the next link', () => {
  expect(continuationInventory([browseSource(browseLink)])).toEqual([]);
  const aliased = browseLink.replace('{ browseHref }', '{ browseHref as href }').replace('? browseHref(', '? href(');
  expect(continuationInventory([browseSource(aliased)])).toEqual([]);
  expect(continuationInventory([browseSource(browseLink.replaceAll('browseHref', 'href'))])).toHaveLength(1);
});

test.each([
  browseLink.replace('cursor: page.nextCursor', 'cursor: null'),
  browseLink.replace('cursor: page.nextCursor', 'cursor: other.nextCursor'),
  browseLink.replace('cursor: page.nextCursor', 'cursor: state.cursor'),
  browseLink.replace('cursor: page.nextCursor', 'cursor: page.nextCursor + "suffix"'),
  browseLink.replace('cursor: page.nextCursor', 'cursor: page.nextCursor, ...other'),
  browseLink.replace('page.nextCursor ? browseHref', 'page.items.length ? browseHref'),
  browseLink.replace('}) : null', '}) : other.nextCursor'),
  browseLink.replace("'./browse-state.ts'", "'./unverified.ts'"),
  browseLink.replace('pageModel(base, state, page)', 'pageModel(base, state, page, browseHref)'),
  browseLink.replace('cursor: page.nextCursor', 'cursor: page.nextCursor, cursor: null'),
  browseLink.replace('}; }', ', ...other }; }'),
  browseLink.replace('}; }', ', next: null }; }'),
])('a planted missing, changed, shadowed or overridden browse continuation is rejected: %s', text => {
  expect(continuationInventory([browseSource(text)]).some(row => row.rule === 'dropped-continuation')).toBe(true);
});

test('the real browseModel carries its cursor, and dropping its next URL is detected without an exception', () => {
  const path = 'apps/web/features/zones/browse-view.ts';
  const original = readFileSync(join(root, path), 'utf8');
  const projection = (text: string) => continuationInventory([source(text, path)])
    .filter(row => row.consumer === 'browseModel' && row.rule === 'dropped-continuation' && row.expression === 'page.items');
  expect(projection(original)).toEqual([]);
  const next = 'next: page.nextCursor ? browseHref(base, { ...state, cursor: page.nextCursor }) : null';
  expect(original).toContain(next);
  expect(projection(original.replace(next, 'next: null'))).toHaveLength(1);
});

test.each(['opaque:+/%?=&雪', '0', ''])('the supported URL encoder preserves opaque cursor bytes: %s', async cursor => {
  const { browseHref, parseBrowseState } = await import('../../apps/web/features/zones/browse-state.ts');
  const href = browseHref('/zone/browse', { ...parseBrowseState({ status: 'ongoing' }), cursor });
  expect(new URL(href, 'https://rezics.example').searchParams.get('cursor')).toBe(cursor || null);
});
