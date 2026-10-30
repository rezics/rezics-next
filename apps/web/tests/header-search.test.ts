import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeaderSearchView } from '../src/search/header-search/header-search';
import { headerSearchAction } from '../src/search/header-search/authority';
import { initialHeaderSearchState, reduceHeaderSearchState } from '../src/search/header-search/state';
import type { SearchScope, SearchScopeKind } from '../src/search/header-search/types';
import { m } from '../src/paraglide/messages.js';

// The former two-mount source assertions contradicted the one-owner product contract.
// Verify the actual query surface rather than matching implementation markup in a source file.
for (const kind of ['Library', 'Collection', 'Realm', 'Zone', 'Agent'] satisfies SearchScopeKind[]) {
  test(`${kind} scope remains removable without claiming unsupported search authority`, () => {
    const scope: SearchScope = { kind, id: 'context', name: 'Context' };
    const state = reduceHeaderSearchState(initialHeaderSearchState(scope), { type: 'focus' });
    const markup = renderToStaticMarkup(
      createElement(HeaderSearchView, { id: 'one', state, locale: 'en', region: null }),
    );
    expect(markup).toContain(m.header_search_remove_scope({ scope: scope.name }));
    expect(markup).toContain(m.header_search_scope_unavailable());
    expect(headerSearchAction('en', scope)).toBeUndefined();
    expect(markup.match(/role="combobox"/g) ?? []).toHaveLength(1);
    expect(markup).not.toContain('name="q"');
  });
}

test('an existing scoped route retains its own hidden context in a plain GET form', () => {
  const scope: SearchScope = {
    kind: 'Library',
    id: 'mine',
    name: 'Library',
    searchAction: '/ja/library?collection=reading',
  };
  const state = initialHeaderSearchState(scope);
  const markup = renderToStaticMarkup(
    createElement(HeaderSearchView, { id: 'one', state, locale: 'ja', region: null }),
  );
  expect(markup).toContain('action="/ja/library"');
  expect(markup).toContain('name="collection" value="reading"');
  expect(markup).toContain('name="q"');
  for (const searchAction of [
    'https://outside.invalid/search',
    '//outside.invalid/search',
    '/\\outside.invalid/search',
  ])
    expect(headerSearchAction('ja', { ...scope, searchAction })).toBeUndefined();
});

test('available route filters report active conditions while preserving the one query', () => {
  const state = reduceHeaderSearchState(initialHeaderSearchState(), { type: 'focus' });
  const markup = renderToStaticMarkup(
    createElement(HeaderSearchView, {
      id: 'one',
      state,
      locale: 'en',
      region: { activeCount: 2, open() {} },
    }),
  );
  expect(markup).toContain(`${m.search_filters()} (2)`);
  expect(markup).not.toContain(m.header_search_filters_unavailable());
  expect(markup.match(/role="combobox"/g) ?? []).toHaveLength(1);
});
