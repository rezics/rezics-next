import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { continuationInventory, changedContinuationGroups } from './web-continuations.ts';

const root = new URL('../../', import.meta.url);
const accepted = JSON.parse(readFileSync(new URL('scripts/static/web-continuations.inventory.json', root), 'utf8'));

// These exact readers inspect emptiness or a bounded preview while carrying owner continuations separately.
// Pin their obligations so a changed scan budget or disconnected navigation cannot inherit that evidence.
test.each([
  ['apps/web/features/discover/browse-state.ts', 'cursor = single(params.cursor) ?? null', 'cursor = single(params.q) ?? null'],
  ['apps/web/features/discover/browse-read.ts', 'result = await read(continuation)', 'result = await read(null)'],
  ['apps/web/features/discover/browse-read.ts', 'checkedPages < BROWSE_SCAN_PAGES', 'checkedPages < 1000'],
  ['apps/web/features/discover/discover-view.tsx', '<BrowseContinuation page={results.data}',
    '<BrowseContinuation page={{ ...results.data, nextCursor: null }}'],
  ['apps/web/features/discover/load.ts', 'api.resources(browseQuery({ ...state, cursor }))', 'api.resources(browseQuery(state))'],
  ['apps/web/features/discover/search-recovery-read.ts', 'page.ok ? page.data.items : []',
    'page.ok ? page.data.items.slice(0, 1) : []'],
] as const)('Discover continuation evidence rejects changed scan/navigation obligations: %s / %s', (path, before, after) => {
  const source = readFileSync(new URL(path, root), 'utf8');
  expect(source).toContain(before);
  expect(changedContinuationGroups(continuationInventory([{ path, source }]), accepted.violations)).toEqual([]);
  expect(changedContinuationGroups(continuationInventory([{ path, source: source.replace(before, after) }]),
    accepted.violations).length).toBeGreaterThan(0);
});
