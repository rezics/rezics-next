import { expect, test } from 'bun:test';
import { parseFilter } from '@rezics/filter';
import { useCollectionOwnerCurrent } from '../src/library/collection-owner-current';
import { createLibrarySearchActionHost } from '../src/library/search-action-binding';
import { SaveQueryLink } from '../src/library/save-query';
import { isolatedSearchLibraryActionHost } from '../src/search/library-action-port';
import { searchSavedQuerySelection } from '../src/search/saved-query-selection';

test('the same executed catalogue request admits the existing saved selection', () => {
  const host = createLibrarySearchActionHost();
  const state = {
    query: '',
    type: 'schema:Book',
    facets: { 'schema:keywords': ['space opera'] },
    ranges: {},
    cursor: undefined,
    sort: undefined,
  };
  const selection = host.selectionFromExecuted(state);
  expect(selection).toEqual(searchSavedQuerySelection(state));
  expect(selection).toEqual({
    state: 'admitted',
    filter: parseFilter({
      and: [{ type: { in: ['schema:Book'] } }, { statement: { property: 'schema:keywords', in: ['space opera'] } }],
    }),
    sort: 'id',
    source: { kind: 'catalogue' },
  });
});

test('the Library adapter installs save, follow and owner observation; isolated trees render none', () => {
  const installed = createLibrarySearchActionHost();
  expect(installed.SaveQuery).toBe(SaveQueryLink);
  expect(installed.useCollectionOwner).toBe(useCollectionOwnerCurrent);
  expect(installed.FollowTarget).not.toBe(isolatedSearchLibraryActionHost.FollowTarget);
  expect(isolatedSearchLibraryActionHost.SaveQuery).not.toBe(SaveQueryLink);
});

test('Search consumers no longer privately import Library save, selection or follow-target files', async () => {
  const results = await Bun.file(new URL('../src/search/search-regions/results.tsx', import.meta.url)).text();
  const selection = await Bun.file(new URL('../src/search/saved-query-selection.ts', import.meta.url)).text();
  const concept = await Bun.file(new URL('../src/features/pages/source-concept-view.tsx', import.meta.url)).text();
  expect(results).toContain('library-action-port');
  expect(results).not.toContain('library/save-query');
  expect(selection).not.toContain('library/saved-query-editor');
  expect(concept).toContain('library-action-port');
  expect(concept).not.toContain('library/follow-target-control');
});
