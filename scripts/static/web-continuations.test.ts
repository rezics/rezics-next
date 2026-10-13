import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedContinuationGroups, continuationInventory, webSources } from './web-continuations.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const accepted = JSON.parse(readFileSync(new URL('./web-continuations.inventory.json', import.meta.url), 'utf8'));
const source = (text: string, path = 'apps/web/features/example/read.ts') => ({ path, source: text });
const forwarded = 'export async function page(api, cursor) { const page = await api.get({ query: { cursor, limit: 20 } }); return { items: page.items, nextCursor: page.nextCursor }; }';

test('production web list flows introduce no unreviewed continuation or cap changes', async () => {
  expect(changedContinuationGroups(continuationInventory(await webSources(root)), accepted.groups)).toEqual([]);
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
])('dropped, invented and capped flows require review', changed => {
  const baseline = continuationInventory([source(forwarded)]);
  expect(changedContinuationGroups(continuationInventory([source(changed)]), baseline)).toHaveLength(1);
  expect(changedContinuationGroups(continuationInventory([source(changed, 'apps/web/features/new/read.ts')]), baseline))
    .toHaveLength(2);
});

test('indirect consumers and dynamic imports cannot drop the adapter continuation unnoticed', () => {
  const adapter = source(forwarded);
  const consumer = source('export async function view() { return (await import("../example/read.ts")).page(); }',
    'apps/web/features/view/show.ts');
  const baseline = continuationInventory([adapter, consumer]);
  expect(changedContinuationGroups(continuationInventory([adapter, { ...consumer,
    source: consumer.source.replace('.page()', '.page().then(p => p.items)') }]), baseline))
    .toEqual(['apps/web/features/view: review opaque forwarding, dropped continuations and capped-list remainder routes']);
});

test('stories do not widen the production inventory', () => {
  const baseline = continuationInventory([source(forwarded)]);
  expect(continuationInventory([source(forwarded), source('api.get({ limit: 1 })',
    'apps/web/features/example/read.stories.tsx')])).toEqual(baseline);
});
