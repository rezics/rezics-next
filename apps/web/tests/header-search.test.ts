import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeaderSearch, HeaderSearchView } from '../src/search/header-search/header-search';
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

// Retained existing regression for the sibling toolbar, which this slice does not change.
const source = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('the shelf toolbar no longer renders a second text search box', async () => {
  const toolbar = await source('../../../packages/ui/src/components/shelf-toolbar.tsx');
  expect(toolbar).not.toContain('<Input');
  expect(toolbar).not.toContain('type="search"');
});

test('phone search exposes a named modal container around one ordinary named GET search form', () => {
  const state = reduceHeaderSearchState(initialHeaderSearchState(undefined, 'Prince'), { type: 'open-phone' });
  const markup = renderToStaticMarkup(
    createElement(HeaderSearchView, {
      id: 'phone',
      state,
      locale: 'en',
      region: null,
      fields: [['type', 'schema:Book']],
    }),
  );
  expect(markup).toStartWith(
    `<div data-header-search="true" data-expanded="true" role="dialog" aria-modal="true" aria-label="${m.search_label()}"`,
  );
  const form = markup.match(/<form\b[^>]*>[\s\S]*?<\/form>/)?.[0];
  expect(form).toBeDefined();
  expect(form).toContain(`role="search" aria-label="${m.search_label()}" method="get" action="/en/search"`);
  expect(form).not.toContain('role="dialog"');
  expect(form).not.toContain('aria-modal');
  expect(form).toContain('name="type" value="schema:Book"');
  expect(form).toContain('name="q"');
  expect(form).toContain('value="Prince"');
  expect(form).toContain('type="submit"');
  expect(markup.match(/<form\b/g)).toHaveLength(1);
  expect(markup.match(/role="search"/g)).toHaveLength(1);
  expect(markup.match(/role="dialog"/g)).toHaveLength(1);
});

test('desktop search remains one named search form at rest and while expanded without modal semantics', () => {
  const rest = initialHeaderSearchState(undefined, 'Prince');
  for (const state of [rest, reduceHeaderSearchState(rest, { type: 'focus' })]) {
    const markup = renderToStaticMarkup(
      createElement(HeaderSearchView, { id: 'desktop', state, locale: 'en', region: null }),
    );
    expect(markup).toContain(`<form id="desktop-form" role="search" aria-label="${m.search_label()}"`);
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('aria-modal');
    expect(markup.match(/<form\b/g)).toHaveLength(1);
    expect(markup.match(/role="combobox"/g)).toHaveLength(1);
  }
});

test('expanded composer uses the panel top rounding and outlines the actual input', () => {
  const markup = renderToStaticMarkup(
    createElement(HeaderSearchView, {
      id: 'desktop',
      state: reduceHeaderSearchState(initialHeaderSearchState(), { type: 'focus' }),
      locale: 'en',
      region: null,
    }),
  );
  const composer = markup.match(/<div data-search-composer="true" class="([^"]*)"/u)?.[1];
  expect(composer).toContain('rounded-t-3xl');
  expect(composer).not.toContain('rounded-full');
  const input = markup.match(/<input\b(?=[^>]*role="combobox")[^>]*>/u)?.[0];
  expect(input).toContain('focus-visible:outline-solid');
  expect(input).toContain('focus-visible:outline-foreground');
});

test('separate HeaderSearch instances keep their shortcut help and form references unique', () => {
  const markup = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(HeaderSearch, { locale: 'en', keyboardShortcut: true }),
      createElement(HeaderSearch, {
        locale: 'en',
        keyboardShortcut: true,
        scope: { kind: 'Collection', id: 'reading', name: 'Reading list' },
      }),
    ),
  );
  const ids = [...markup.matchAll(/\bid="([^"]+)"/gu)].map(([, id]) => id!);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);

  const references = [...markup.matchAll(/\baria-(?:controls|describedby|activedescendant)="([^"]+)"/gu)]
    .flatMap(([, value]) => value!.split(/\s+/u))
    .filter(Boolean);
  for (const reference of references) expect(ids.filter((id) => id === reference)).toHaveLength(1);

  expect(markup).toContain(`aria-label="${m.header_search_global()} Ctrl/⌘ K"`);
  expect(markup).toContain(`aria-label="${m.header_search_in_scope({ scope: 'Reading list' })} Ctrl/⌘ K"`);
});

test('duplicate instances keep query and scoped names attached to their own visible shortcut and input help', () => {
  const markup = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(HeaderSearch, {
        locale: 'en',
        initialQuery: 'A visible draft',
        keyboardShortcut: true,
      }),
      createElement(HeaderSearch, {
        locale: 'en',
        keyboardShortcut: true,
        scope: { kind: 'Collection', id: 'reading', name: 'Reading list' },
      }),
    ),
  );
  const triggers = [...markup.matchAll(/<button\b[^>]*class="header-search-trigger[^>]*>[\s\S]*?<\/button>/gu)].map(
    ([trigger]) => trigger,
  );
  expect(triggers).toHaveLength(2);
  const attribute = (element: string, name: string) => element.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))?.[1];
  expect(triggers.map((trigger) => attribute(trigger, 'aria-label'))).toEqual([
    'A visible draft Ctrl/⌘ K',
    `${m.header_search_in_scope({ scope: 'Reading list' })} Ctrl/⌘ K`,
  ]);
  for (const trigger of triggers) {
    expect(trigger).toContain('</span> <kbd');
    expect(trigger).toContain('aria-keyshortcuts="Control+k Meta+k"');
  }

  const helpIds = [...markup.matchAll(/<span id="([^"]+-keyboard-help)"/gu)].map(([, id]) => id!);
  expect(helpIds).toHaveLength(2);
  expect(new Set(helpIds).size).toBe(2);
  const inputs = [...markup.matchAll(/<input\b(?=[^>]*role="combobox")[^>]*>/gu)].map(([input]) => input!);
  expect(inputs).toHaveLength(2);
  for (const [index, input] of inputs.entries()) {
    expect(input).toContain(`aria-label="${m.search_label()}"`);
    expect(input).toContain(`aria-describedby="${helpIds[index]}"`);
  }
});
