import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedContinuationGroups, continuationInventory, pagedOperations, webSources } from './web-continuations.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const accepted = JSON.parse(readFileSync(new URL('./web-continuations.inventory.json', import.meta.url), 'utf8'));
const source = (text: string, path = 'apps/web/features/example/read.ts') => ({ path, source: text });
const forwarded = 'export async function page(api, cursor) { const page = await api.get({ query: { cursor, limit: 20 } }); return { items: page.items, nextCursor: page.nextCursor }; }';

test('production web list flows introduce no new continuation or cap violations', async () => {
  const api = JSON.parse(readFileSync(new URL('../../generated/openapi/main/public.json', import.meta.url), 'utf8'));
  const current = continuationInventory(await webSources(root), pagedOperations(api));
  expect(changedContinuationGroups(current, accepted.violations)).toEqual([]);
});

test('unchanged opaque forwarding passes, including punctuation in cursor values', () => {
  const sources = [source(forwarded.replace('api, cursor', 'api, cursor = "opaque:+/%?="'))];
  expect(changedContinuationGroups(continuationInventory(sources), continuationInventory(sources))).toEqual([]);
});

test('benign edits to a correctly forwarding consumer need no review or baseline update', () => {
  const baseline = continuationInventory([source(forwarded)]);
  const harmless = `// Explain the response.\n${forwarded}`;
  expect(changedContinuationGroups(continuationInventory([source(harmless)]), baseline)).toEqual([]);
});

test.each([
  forwarded.replace('nextCursor: page.nextCursor', 'nextCursor: null'),
  forwarded.replace('cursor, limit', 'cursor: Number(cursor) + 20, limit'),
  'export async function page(api) { return (await api.get({ query: { limit: 100 } })).items; }',
])('dropped, invented and capped flows fail without a review baseline', changed => {
  const baseline = continuationInventory([source(forwarded)]);
  expect(changedContinuationGroups(continuationInventory([source(changed)]), baseline)).toHaveLength(1);
  expect(changedContinuationGroups(continuationInventory([source(changed, 'apps/web/features/new/read.ts')]), baseline))
    .toHaveLength(1);
});

test('indirect consumers and dynamic imports cannot drop the adapter continuation unnoticed', () => {
  const adapter = source(forwarded);
  const consumer = source('export async function view() { return (await import("../example/read.ts")).page(); }',
    'apps/web/features/view/show.ts');
  const baseline = continuationInventory([adapter, consumer]);
  expect(changedContinuationGroups(continuationInventory([adapter, { ...consumer,
    source: consumer.source.replace('.page()', '.page().then(p => p.items)') }]), baseline))
    .toEqual([expect.stringContaining('apps/web/features/view/show.ts: view:')]);
});

test('additional correctly forwarding consumers pass with no baseline changes', () => {
  const baseline = continuationInventory([source(forwarded)]);
  expect(changedContinuationGroups(continuationInventory([source(forwarded),
    source(forwarded, 'apps/web/features/new/read.ts')]), baseline)).toEqual([]);
});

test.each([
  'const items = page.items; return items;',
  'if (!page.ok) return page; return page.data.items;',
  'const { items } = page; return items;',
  'const { items, nextCursor } = page; return items;',
])('items aliases and failure returns do not forward the remainder: %s', tail => {
  const text = `export async function read(api) { const page = await api.get({ query: { limit: 20 } }); ${tail} }`;
  expect(continuationInventory([source(text)])).toHaveLength(1);
});

test('a second page cannot borrow a first page’s forwarding', () => {
  const text = forwarded.replace('return {', 'const extra = await api.get({ query: { limit: 10 } }); const rows = extra.items; return {');
  expect(continuationInventory([source(text)])).toHaveLength(1);
});

test.each([
  forwarded.replace('cursor, limit', 'cursor: "invented", limit'),
  forwarded.replace('const page =', 'const seek = Number(cursor) + 20; const page =').replace('cursor, limit', 'cursor: seek, limit'),
  forwarded.replace('const page =', 'cursor += 20; const page ='),
  forwarded.replace('return {', 'const ignored = page.nextCursor; return {').replace('nextCursor: page.nextCursor', 'nextCursor: null'),
  forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'const ignored = page.nextCursor; return page.items;'),
  forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'return {...page, nextCursor: null};'),
  forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'delete page.nextCursor; return page;'),
  forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'page.nextCursor = null; return page;'),
])('invented aliases and explicit dropped outputs fail', text => {
  expect(continuationInventory([source(text)])).toHaveLength(1);
});

test.each(['return items;', 'return {ok:true,data:items};'])('bounded accumulation cannot turn request forwarding into an items-only outcome: %s', result => {
  const text = 'export async function read(api) { const items = []; let cursor; for(let i=0;i<5;i++) { const page = await api.get({query:{cursor,limit:20}}); items.push(...page.items); cursor=page.nextCursor; if(!cursor) break; } return items; }';
  expect(continuationInventory([source(text.replace('return items;', result))])).toHaveLength(1);
});

test('whole envelopes, alias continuations and null restarts keep opaque cursors', () => {
  for (const text of [forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'return page;'),
    forwarded.replace('return {', 'const next = page.nextCursor; return {').replace('nextCursor: page.nextCursor', 'nextCursor: next'),
    forwarded.replace('cursor, limit', 'cursor: cursor ?? undefined, limit'),
    forwarded.replace('return { items: page.items, nextCursor: page.nextCursor };', 'const {items,nextCursor} = page; return {items,nextCursor};'),
    forwarded.replace('api.get(', 'api /* benign */ .get( /* benign */ ')]) {
    expect(continuationInventory([source(text)])).toEqual([]);
  }
});

test('an existing exemption cannot cover a newly capped request at the same site', () => {
  const text = 'export async function read(api) { return (await api.get({query:{limit:1}})).items; }';
  expect(changedContinuationGroups(continuationInventory([source(text.replace('limit:1', 'limit:100'))]),
    continuationInventory([source(text)]))).toHaveLength(1);
});

test('default-bounded API pages cannot be reduced to arrays after a refusal branch', () => {
  const text = 'export const readRatings = cache(async () => { const contexts = await settle(() => main.v1.resources({resource: id})["rating-contexts"].get({query:{actingSubject}})); if (!contexts.ok) return contexts; const items = contexts.data.items; return {contexts: items}; });';
  expect(continuationInventory([source(text)], new Set(['GET /v1/resources/{resource}/rating-contexts']))).toHaveLength(1);
});

test('stories do not widen the production inventory', () => {
  const baseline = continuationInventory([source(forwarded)]);
  expect(continuationInventory([source(forwarded), source('api.get({ limit: 1 })',
    'apps/web/features/example/read.stories.tsx')])).toEqual(baseline);
});
