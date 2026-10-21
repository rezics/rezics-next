import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newPageSelections, pageSelections } from './web-page-filtering.ts';
import { pagedOperations, webSources } from './web-continuations.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = (source: string, path = 'apps/web/features/example/read.ts') => ({ path, source });
const correct = 'export async function browse(api, type) { const page = await api.v1.works.get({ query: { limit: 20, type } }); return page; }';
const filtered = correct.replace('return page;', 'return { ...page, items: page.items.filter(item => item.type === type) };');

test('production web page predicates have structural evidence or an explicit API gap', async () => {
  const api = JSON.parse(readFileSync(new URL('../../generated/openapi/main/public.json', import.meta.url), 'utf8'));
  const operations = pagedOperations(api);
  const current = pageSelections(await webSources(root), operations);
  const accepted = JSON.parse(readFileSync(new URL('./web-page-filtering.inventory.json', import.meta.url), 'utf8'));
  expect(newPageSelections(current, accepted)).toEqual([]);
}, 60_000);

test('server selection and new correctly filtered consumers pass', () => {
  expect(pageSelections([source(correct), source(correct, 'apps/web/features/new/read.ts')])).toEqual([]);
});

test.each([
  filtered,
  filtered.replace('.filter(item => item.type === type)', '.find(item => item.type === type)'),
  filtered.replace('.filter(item => item.type === type)', '.flatMap(item => item.type === type ? [item] : [])'),
  correct.replace('return page;', 'const items = page.items; return items.filter(eligible);'),
  correct.replace('return page;', 'const items = page.items.map(adapt); return items.filter(eligible);'),
  correct.replace('return page;', 'const items = []; for (const item of page.items) { if (!eligible(item)) continue; items.push(item); } return items;'),
])('capped page selections fail, including aliases and imperative joins', text => {
  expect(newPageSelections(pageSelections([source(text)]), [])).not.toHaveLength(0);
});

test('imported page adapters retain selection provenance', () => {
  const consumer = source('import { browse as read } from "../example/read.ts"; export async function view() { const page = await read(); return page.items.filter(eligible); }', 'apps/web/features/view/show.ts');
  expect(pageSelections([source(correct), consumer])[0]?.operation).toBe('GET /v1/works');
});

test('one evidenced predicate admits trivia edits, never an additional or changed predicate', () => {
  const accepted = pageSelections([source(filtered)]);
  expect(newPageSelections(pageSelections([source(filtered.replace('item.type === type', 'item.type /* explanation */ === type'))]), accepted)).toEqual([]);
  expect(newPageSelections(pageSelections([source(filtered.replace('item.type === type', 'item.type !== type'))]), accepted)).not.toHaveLength(0);
  expect(newPageSelections(pageSelections([source(filtered.replace('return {', 'page.items.filter(other); return {'))]), accepted)).not.toHaveLength(0);
  expect(newPageSelections(pageSelections([source(filtered.replace('return {', 'page.items.filter(item => item.type === type); return {'))]), accepted)).toHaveLength(1);
  expect(newPageSelections(pageSelections([source(filtered.replace('.filter(', '.find('))]), accepted)).toHaveLength(1);
});

test('fixtures and stories are excluded from the production scan', () => {
  expect(pageSelections([source(filtered, 'apps/web/features/example/read.stories.tsx')])).toEqual([]);
});

test('a proved complete small page passes only while its failure branch remains', () => {
  const complete = correct.replace('return page;', 'if (page.nextCursor) return { ok: false, failure: "unavailable" }; return page.items.filter(eligible);');
  expect(pageSelections([source(complete)])).toEqual([]);
  expect(pageSelections([source(complete.replace('if (page.nextCursor) return { ok: false, failure: "unavailable" };', ''))])).toHaveLength(1);
  expect(pageSelections([source(complete.replace('page.nextCursor', 'other.nextCursor'))])).toHaveLength(1);
  expect(pageSelections([source(complete.replace('return page.items', 'page = await api.v1.works.get({query:{limit:20}}); return page.items'))])).toHaveLength(1);
});

test('an evidenced helper cannot admit a new caller eligibility predicate', () => {
  const helper = source('export async function select(read, keep) { const page = await read(); return {items:page.items.filter(keep),nextCursor:page.nextCursor}; }');
  const consumer = source('import {select} from "../example/read.ts"; async function view(api) { return select(() => api.v1.works.get({query:{limit:20}}), item => item.year === 2020); }', 'apps/web/features/view/read.ts');
  expect(newPageSelections(pageSelections([helper, consumer]), pageSelections([helper]))).toHaveLength(1);
});

test('passing page items into an imported helper still guards its eligibility filter', () => {
  const helper = source('export function eligible(items) { return items.filter(item => item.year === 2020); }');
  const caller = source('import {eligible} from "../example/read.ts"; async function view(api) { const page=await api.v1.works.get({query:{limit:20}}); return eligible(page.items); }', 'apps/web/features/view/read.ts');
  expect(pageSelections([helper, caller])).toHaveLength(1);
});

const enrichment = `export async function browse(api, hubSummary) {
  const page = await api.v1.works.get({ query: { limit: 20 } });
  const entries = page.items;
  const kinds = entries.flatMap(entry => bindingSummary(entry, 'kind', hubSummary)?.reference ?? []);
  const native = page;
  const output = { result: { native }, kinds };
  return output;
}`;

test.each([
  enrichment,
  enrichment.replaceAll('bindingSummary', 'lookup').replaceAll('reference', 'label').replaceAll('kinds', 'names'),
  enrichment.replace('const native = page;', 'const wrapper = { page }; const native = wrapper.page;'),
  enrichment.replace('return output;', 'return { ...output, label: "Kinds" };'),
  enrichment.replace('const native = page;', 'const native = page; const allKinds = kinds;').replace('native }, kinds', 'native }, kinds: allKinds'),
])('separate enrichment does not select an intact returned incidence page: %s', text => {
  expect(pageSelections([source(text)])).toEqual([]);
});

test.each([
  enrichment.replace('return output;', 'return kinds;'),
  enrichment.replace('return output;', 'return { ...output, result: { native: other } };'),
  enrichment.replace('return output;', 'return { ...output, ...other };'),
  enrichment.replace('return output;', 'return { output, replacement: { ...page, items: kinds } };'),
  enrichment.replace('return output;', 'return { output, replacement: { items: kinds, next: page.next } };'),
  enrichment.replace('return output;', 'const replacement = { items: kinds }; return { output, replacement };'),
  enrichment.replace('result: { native }', 'result: { native: { ...native, items: kinds } }'),
  enrichment.replace('result: { native }', 'result: { native: { ...native, next: null } }'),
  enrichment.replace('return output;', 'page.items = kinds; return output;'),
  enrichment.replace('return output;', 'Object.assign(page, { items: kinds }); return output;'),
  enrichment.replace('return output;', 'entries.pop(); return output;'),
  enrichment.replace('return output;', 'return page.items.length ? output : { items: [], next: null };'),
  enrichment.replace("bindingSummary(entry, 'kind', hubSummary)?.reference ?? []", 'entry.kind ? [entry] : []'),
  enrichment.replace("bindingSummary(entry, 'kind', hubSummary)?.reference ?? []", 'bindingSummary(entry, "kind", hubSummary) ?? []'),
  enrichment.replace('entries.flatMap', 'entries.filter'),
])('the same enrichment syntax cannot cover lost pages, overrides, mutations or selected incidences: %s', text => {
  expect(pageSelections([source(text)])).not.toHaveLength(0);
});
