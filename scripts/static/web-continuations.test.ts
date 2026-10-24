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

test('the bounded browse scan exception refuses a changed owner continuation', () => {
  const path = 'apps/web/features/discover/browse-read.ts';
  const original = readFileSync(join(root, path), 'utf8');
  const retained = 'return { result, checkedPages };';
  expect(original).toContain(retained);
  expect(changedContinuationGroups(continuationInventory([source(original, path)]), accepted.violations)).toEqual([]);
  const dropped = original.replace(retained,
    'return { result: { ...result, data: { ...result.data, nextCursor: null } }, checkedPages };');
  expect(changedContinuationGroups(continuationInventory([source(dropped, path)]), accepted.violations))
    .toContain(`${path}: readBrowseScan: <syntax>: dropped-continuation: result.data.items`);
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

// Studio's renderer receives an owner page and its navigation separately.
// These exact exceptions must stop applying when either flow changes.
test.each([
  ['apps/web/features/studio/read.ts', 'page: { ...page.data, items }', 'page: { ...page.data, items, nextCursor: null }'],
  ['apps/web/features/studio/studio-home.tsx', '{moreHref ? <Link', '{false ? <Link'],
  ['apps/web/app/[locale]/studio/[agent]/page.tsx', 'validCursor(query.cursor)', 'validCursor(query.cursor + "suffix")'],
] as const)('Studio continuation evidence rejects dropped owner continuation or navigation: %s / %s', (path, before, after) => {
  const original = readFileSync(join(root, path), 'utf8');
  expect(original).toContain(before);
  expect(changedContinuationGroups(continuationInventory([source(original, path)]), accepted.violations)).toEqual([]);
  expect(changedContinuationGroups(continuationInventory([source(original.replace(before, after), path)]), accepted.violations).length)
    .toBeGreaterThan(0);
});


// Accessibility descriptions and route selection changed these readers' syntax.
// Their reviewed exceptions must still reject truncated items or altered tokens.
test.each([
  ['apps/web/features/home/continue-strip.tsx', 'const shown = items.filter(',
    'const shown = items.slice(0, 1).filter('],
  ['apps/web/features/zones/site-route.tsx', 'readMembers(site, route.mount.segment, route.items, locale, state)',
    'readMembers(site, route.mount.segment, route.items.slice(0, 1), locale, state)'],
  ['apps/web/features/zones/site-route.tsx',
    'const { ref } = view.context;\n  const cursor = routeCursor(path, search);',
    'const { ref } = view.context;\n  const cursor = routeCursor(path, search) + "suffix";'],
] as const)('reviewed Home and routing contexts reject changed item or cursor flow: %s / %s', (path, before, after) => {
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

const retained = `export function project(page, positions) {
  const entries = page.items;
  const kinds = entries.flatMap(entry => entry.kind ?? []);
  const native = page;
  const output = { nested: { native }, kinds, cursor: positions.family, discovery: { cursor: positions.variants } };
  return output;
}`;

test('a native next frontier is rejected before a non-navigable complete-batch iteration', () => {
  const text = `export function actions(page) {
    const actions = [];
    if (page.next) return [];
    for (const entry of page.items) actions.push(entry.id);
    return actions;
  }`;
  expect(continuationInventory([source(text)])).toEqual([]);
  expect(continuationInventory([source(text.replace('if (page.next) return [];', ''))])).toHaveLength(1);
  expect(continuationInventory([source(text.replace('if (page.next)', 'if (other.next)'))])).toHaveLength(1);
  expect(continuationInventory([source(text.replace('if (page.next) return [];', 'if (page.next) actions.push("more");'))])).toHaveLength(1);
});

test('an explicitly complete batch is refused before an item lookup and cannot borrow a different flag', () => {
  const text = `export function read(batch, ref) {
    if (!batch.complete) return { ok: false };
    const item = batch.items.find(item => item.ref === ref);
    return { ok: true, item };
  }`;
  expect(continuationInventory([source(text)])).toEqual([]);
  for (const changed of [
    text.replace('if (!batch.complete) return { ok: false };', ''),
    text.replace('!batch.complete', '!other.complete'),
    text.replace('!batch.complete', 'batch.complete'),
    text.replace('return { ok: false };', 'observe(batch);'),
    text.replace('return { ok: false };', 'return { items: [], complete: true };'),
    text.replace('return { ok: false };', 'return { ok: true, items: [] };'),
    text.replace('return { ok: false };', 'return { ok: false, ...unknown };'),
    text.replace('const item =', 'batch = other; const item ='),
  ]) expect(continuationInventory([source(changed)]).length).toBeGreaterThan(0);
  const showcase = `export function readShowcase(read, reference) {
    if (!read.ok) return read;
    if (!read.data.complete) return { ok: false, failure: 'unavailable' };
    const selection = read.data.items.find(item => item.reference === reference);
    return { ok: true, data: selection };
  }`;
  expect(continuationInventory([source(showcase)])).toEqual([]);
  expect(continuationInventory([source(showcase.replace("{ ok: false, failure: 'unavailable' }", '{ ok: true, data: [] }'))]).length)
    .toBeGreaterThan(0);
});

test('constructed group admission checks opaque receiver and nested items lifetimes', () => {
  for (const text of [
    `export function view() { const group = { items: [], mutate: opaque }; group.mutate(); return group.items; }`,
    `export function view() { const group = { items: [] }; opaque(group.items); return group.items; }`,
    `export function view() { const group = { items: [], mutate: opaque }; const alias = group; alias.mutate(); return group.items; }`,
    `export function view() { const group = { items: [] }; const items = group.items; opaque(items); return group.items; }`,
    `export function view() { const group = { items: [] }; group.items.mutate(); return group.items; }`,
    `export function view() { const group = { items: [] }; const alias = group; alias.items = page.items; return group.items; }`,
  ]) expect(continuationInventory([source(text)]).length).toBeGreaterThan(0);
  expect(continuationInventory([source(`export function view() { const group = { items: [], label: 'label' };
    group.items.push({ label: 'one' }); label(group.label); return group.items.map(item => item.label); }`)])).toEqual([]);
});

test('locally constructed Map groups have no page frontier while injected native envelopes still require one', () => {
  const text = `export function rows(entries) {
    const groups = new Map();
    for (const entry of entries) {
      const group = groups.get(entry.kind) ?? { heading: entry.kind, items: [] };
      group.items.push(entry);
      groups.set(entry.kind, group);
    }
    return [...groups.values()];
  }`;
  expect(continuationInventory([source(text)])).toEqual([]);
  for (const changed of [
    text.replace('new Map()', 'externalMap'),
    text.replace('groups.set(entry.kind, group);', 'groups.set(entry.kind, page);'),
    text.replace('group.items.push(entry);', 'group.items = page.items; group.items.push(entry);'),
    text.replace('group.items.push(entry);', 'mutate(group); group.items.push(entry);'),
    text.replace('heading: entry.kind, items: []', 'heading: entry.kind, items: [], next: page.next'),
  ]) expect(continuationInventory([source(changed)]).length).toBeGreaterThan(0);
});

const constructedGroups = `export function buildGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.kind) ?? { label: entry.kind, items: [] };
    group.items.push(entry);
    groups.set(entry.kind, group);
  }
  return [...groups].map(([key, { label, items }]) => ({ key, label, items }));
}
export function project(page) {
  return { page, groups: buildGroups(page.items) };
}`;

test('derived group items keep their finite literal/Map origin through returned fields and private JSX inputs', () => {
  const component = `import { project } from './groups.ts';
    function Groups({ result }) { return result.groups.map(group => <p>{group.items.map(item => item.label)}</p>); }
    export function View({ page }) { const result = project(page); return <Groups result={result}/>; }`;
  const sources = [source(constructedGroups, 'apps/web/features/example/groups.ts'), source(component, 'apps/web/features/example/view.tsx')];
  expect(continuationInventory(sources)).toEqual([]);
  const siblingCursor = component.replace('return <Groups result={result}/>;', 'return <div>{link(result.page.next)}<Groups result={result}/></div>;');
  expect(continuationInventory([sources[0]!, source(siblingCursor, sources[1]!.path)])).toEqual([]);
  const siblingMetadata = component.replace('<p>{group.items.map(item => item.label)}</p>', '<p>{label(group.label)}{group.items.map(item => item.label)}</p>');
  expect(continuationInventory([sources[0]!, source(siblingMetadata, sources[1]!.path)])).toEqual([]);
  for (const write of ['group.items = foreign;', 'group.next = token;', 'group.nextCursor = token;', 'mutate(group.items);', 'mutate(group);']) {
    const changed = siblingMetadata.replace('group => <p>', `group => { ${write} return <p>`).replace('</p>);', '</p>; });');
    expect(continuationInventory([sources[0]!, source(changed, sources[1]!.path)]).length).toBeGreaterThan(0);
  }
  for (const changed of [
    constructedGroups.replace('groups.set(entry.kind, group);', 'groups.set(entry.kind, nativePage);'),
    constructedGroups.replace('group.items.push(entry);', 'group.items = foreign; group.items.push(entry);'),
    constructedGroups.replace('group.items.push(entry);', 'mutate(group); group.items.push(entry);'),
    constructedGroups.replace('label: entry.kind, items: []', 'label: entry.kind, items: [], next: token'),
    constructedGroups.replace('({ key, label, items })', '({ key, label, items: foreign })'),
    constructedGroups.replace('return { page, groups: buildGroups(page.items) };', 'return { groups: buildGroups(page.items) };'),
  ]) expect(continuationInventory([source(changed, sources[0]!.path), sources[1]!]).length).toBeGreaterThan(0);
  for (const changed of [
    component.replace('<Groups result={result}/>', '<Groups result={result} {...unknown}/>'),
    component.replace('<Groups result={result}/>', '<Groups result={other}/>'),
    component.replace('const result = project(page);', 'const result = project(page); result.groups = unknown;'),
    component.replace('const result = project(page);', 'const result = project(page); mutate(result);'),
    component.replace('const result = project(page);', 'const result = project(page); mutate(result.groups);'),
    component.replace('export function View', 'observe(Groups); export function View'),
    component.replace('export function View', 'export function Groups({ result }) { return null; } export function View'),
  ]) expect(continuationInventory([sources[0]!, source(changed, sources[1]!.path)]).length).toBeGreaterThan(0);
});

test('an exported row component requires proved inputs at every relative-import caller', () => {
  const component = `export function Rows({ rows }) { return rows.filter(row => row.label).map(row => row.items.map(item => item.label)); }`;
  const consumer = `import { buildGroups } from './groups.ts'; import { Rows } from './rows.tsx';
    export function View({ entries }) { const rows = buildGroups(entries); return <Rows rows={rows}/>; }`;
  const sources = [source(constructedGroups, 'apps/web/features/example/groups.ts'), source(component, 'apps/web/features/example/rows.tsx'),
    source(consumer, 'apps/web/features/example/view.tsx')];
  expect(continuationInventory(sources)).toEqual([]);
  for (const extra of [
    `import { Rows } from './rows.tsx'; export function Lost({ page }) { return <Rows rows={page}/>; }`,
    `import { Rows } from './rows.tsx'; export function Lost({ page }) { return <Rows rows={page.items}/>; }`,
    `import { Rows } from './rows.tsx'; export const escape = Rows;`,
    `import * as UI from './rows.tsx'; export function Lost({ page }) { return <UI.Rows rows={page}/>; }`,
    `export { Rows } from './rows.tsx';`,
    `export async function Lost({ page }) { const ns = await import('./rows.tsx'); return ns.Rows({ rows: page.items }); }`,
    `export async function Lost({ page, target }) { const ns = await import(target); return ns.Rows({ rows: page.items }); }`,
  ]) expect(continuationInventory([...sources, source(extra, 'apps/web/features/example/other.tsx')]).length).toBeGreaterThan(0);
});

const localRead = `function labels(entries) { return entries.map(entry => entry.label); }
  export function project(page) {
    const labelsOfPage = labels(page.items);
    return { page, labels: labelsOfPage };
  }`;

test('a conditional spread can add known disjoint fields but cannot replace retained native data', () => {
  const added = retained.replace('return output;', 'return { ...output, ...(show ? { rating: 1 } : {}) };');
  expect(continuationInventory([source(added)])).toEqual([]);
  for (const changed of [
    added.replace('{ rating: 1 }', '{ nested: { native: other } }'),
    added.replace('{ rating: 1 }', 'unknown'),
    added.replace('{ rating: 1 }', '{ [key]: 1 }'),
  ]) expect(continuationInventory([source(changed)]).length).toBeGreaterThan(0);
});

test('selected pages remain native when local section records add only unrelated presentation fields', () => {
  const text = `export function project(page) {
    const nativePages = [];
    nativePages.push(page);
    const records = [];
    const entries = page.items;
    records.push({ page, members: [] });
    for (const record of records) record.legend = "example";
    return { nativePages, records, labels: entries.map(entry => entry.label) };
  }`;
  expect(continuationInventory([source(text)])).toEqual([]);
  for (const changed of [
    text.replace('nativePages.push(page);', ''),
    text.replace('nativePages.push(page);', 'if (flag) nativePages.push(page);'),
    text.replace('nativePages.push(page);', 'nativePages.push(page); nativePages.pop();'),
    text.replace('record.legend = "example"', 'record.page.items.pop()'),
    text.replace('record.legend = "example"', 'record.page.next = null'),
    text.replace('record.legend = "example"', 'mutate(record)'),
    text.replace('record.legend = "example"', 'mutate(record.page)'),
    text.replace('record.legend = "example"', 'record.page.items.map(unknown)'),
    text.replace('for (const record of records) record.legend = "example";', 'const alias = records.at(0).page; alias.next = null;'),
  ]) expect(continuationInventory([source(changed)]).length).toBeGreaterThan(0);
});

test('finite local helper evidence preserves the raw page and rejects writes, opaque escapes and returned aliases', () => {
  expect(continuationInventory([source(localRead)])).toEqual([]);
  for (const changed of [
    localRead.replace('return { page, labels: labelsOfPage };', 'return { labels: labelsOfPage };'),
    localRead.replace('return entries.map(entry => entry.label);', 'entries.pop(); return [];'),
    localRead.replace('return entries.map(entry => entry.label);', 'mutate(entries); return [];'),
    localRead.replace('return entries.map(entry => entry.label);', 'return entries;'),
    localRead.replace('return entries.map(entry => entry.label);', 'return { nested: entries };'),
    localRead.replace('return entries.map(entry => entry.label);', 'escaped = entries; return [];'),
    localRead.replace('return entries.map(entry => entry.label);', 'new Sink(entries); return [];'),
    localRead.replace('return entries.map(entry => entry.label);', 'return labels(entries);'),
    localRead.replace('const labelsOfPage =', 'labels = unknown; const labelsOfPage ='),
    localRead.replace('project(page)', 'project(page, labels)'),
    localRead.replace('const labelsOfPage =', 'const labels = unknown; const labelsOfPage ='),
    localRead.replace('const labelsOfPage =', 'function labels(entries) { entries.pop(); } const labelsOfPage ='),
    localRead.replace('entries.map(entry => entry.label)', 'entries.map(entry => { entry.label = "changed"; return entry.label; })'),
    localRead.replace('entries.map(entry => entry.label)', 'entries.map(unknown)'),
    localRead.replace('entries.map(entry => entry.label)', 'entries.map((entry, index, original) => { original.pop(); return entry.label; })'),
    localRead.replace('entries.map(entry => entry.label)', 'entries.reduce((all, entry) => all, [])'),
  ]) expect(continuationInventory([source(changed)]).length).toBeGreaterThan(0);
});

test.each([
  retained,
  retained.replace('const native = page;', 'const wrapper = { original: page }; const native = wrapper.original;'),
  retained.replace('return output;', 'return { ...output, label: "Kinds" };'),
  retained.replace('const native = page;', 'const native = page as NativePage;'),
  retained.replace('const native = page;', 'const native = page; const current = positions.family;')
    .replace('cursor: positions.family', 'cursor: current'),
  retained.replace('const native = page;', 'const native = page; const { family: current } = positions;')
    .replace('cursor: positions.family', 'cursor: current'),
  retained.replace('cursor: positions.family', 'cursor: positions.family ?? null'),
  retained.replace('return output;', 'return { ...page, kinds };'),
])('a retained native page and input current positions survive aliases and nested output: %s', text => {
  expect(continuationInventory([source(text)])).toEqual([]);
});

test.each([
  retained.replace('return output;', 'return { kinds };'),
  retained.replace('return output;', 'return { ...output, nested: { native: other } };'),
  retained.replace('return output;', 'return { ...output, ...other };'),
  retained.replace('return output;', 'return { ...output, [key]: other };'),
  retained.replace('return output;', 'return { output, replacement: { ...page, items: kinds } };'),
  retained.replace('return output;', 'return { output, replacement: { ...page, next: null } };'),
  retained.replace('nested: { native }', 'nested: { native: { ...native, items: [] } }'),
  retained.replace('nested: { native }', 'nested: { native: { ...native, next: null } }'),
  retained.replace('nested: { native }', 'nested: { native: { ...native, nextCursor: null } }'),
  retained.replace('return output;', 'return page.items.length ? output : { items: [], next: null };'),
  retained.replace('return output;', 'page.next = null; return output;'),
  retained.replace('return output;', 'native.items = []; return output;'),
  retained.replace('return output;', '({ next: native.next } = other); return output;'),
  retained.replace('return output;', 'entries.splice(0, 1); return output;'),
  retained.replace('entry => entry.kind ?? []', 'entry => { entry.kind = null; return []; }'),
  retained.replace('entry => entry.kind ?? []', 'entry => { const alias = entry; alias.kind = null; return []; }'),
  retained.replace('return output;', 'for (const entry of entries) entry.kind = null; return output;'),
  retained.replace('return output;', 'const { ...alias } = page; alias.items.pop(); return output;'),
  retained.replace('return output;', 'const { items: rows } = page; rows.pop(); return output;'),
  retained.replace('return output;', 'Object.assign(native, { next: null }); return output;'),
  retained.replace('return output;', 'mutate(native); return output;'),
  retained.replace('return output;', 'page = other; return output;'),
  retained.replace('return output;', 'const change = () => { page.next = null; }; change(); return output;'),
  retained.replace('const native = page;', 'let native = page; native = other;'),
])('a page read cannot borrow retention from a lost, overwritten or mutated output: %s', text => {
  expect(continuationInventory([source(text)]).some(row => row.rule === 'dropped-continuation')).toBe(true);
});

test.each([
  retained.replace('page, positions', 'page').replace('const entries', 'const positions = { family: "fake", variants: "fake" }; const entries'),
  retained.replace('page, positions', 'page').replace('const entries', 'const positions = makePositions(); const entries'),
  retained.replace('cursor: positions.family', 'cursor: positions.family + "suffix"'),
  retained.replace('cursor: positions.family', 'cursor: Number(positions.family) + 20'),
  retained.replace('const entries', 'positions.family = "fake"; const entries'),
  retained.replace('const entries', 'mutate(positions); const entries'),
  retained.replace('const entries', 'const current = { family: "fake" }; const entries').replace('cursor: positions.family', 'cursor: current.family'),
  retained.replace('const entries', 'const current = { cursor: "fake" }; const entries').replace('cursor: positions.family', 'cursor: current.cursor'),
  retained.replace('const entries', 'const cursor = "fake"; const entries').replace('cursor: positions.family', 'cursor'),
])('current positions require an unchanged incoming value, independently of property names: %s', text => {
  expect(continuationInventory([source(text)]).some(row => row.rule === 'invented-continuation')).toBe(true);
});

test('a function binding is not a cursor value; using its name as a token still fails', () => {
  const helper = 'export function read(page) { const continuation = value => ({cursor:value}); return {page, next:continuation(page.next)}; }';
  expect(continuationInventory([source(helper)])).toEqual([]);
  expect(continuationInventory([source(helper.replace('next:continuation(page.next)', 'continuation'))])).toEqual([]);
  expect(continuationInventory([source(helper.replace('next:continuation(page.next)', 'cursor:continuation'))])
    .some(row => row.rule === 'invented-continuation')).toBe(true);
});
