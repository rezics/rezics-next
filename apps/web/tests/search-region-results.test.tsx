import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { SearchResultsRegion, type SearchResultsRegionProps } from '../src/search/search-regions/results';
import { m } from '../src/paraglide/messages.js';

const props: SearchResultsRegionProps = {
  query: 'Mira',
  locale: 'en',
  selectedFacets: {},
  data: {
    discovery: { status: 'ready', page: discoveryExample },
    queryState: { query: 'Mira', facets: {}, type: undefined, cursor: undefined, sort: undefined },
    hitTypes: {},
    yearProperties: [],
    typeChoices: [],
    groups: [],
    selectedFacetLabels: {},
    facetRetry: false,
    facetIndexNotReady: false,
    staleCursorRestarted: false,
    sort: 'relevance',
  },
};

test('the result region preserves mixed native identities and current loader context', () => {
  const html = renderToStaticMarkup(<SearchResultsRegion {...props} />);
  expect(html).toContain('data-search-results');
  expect(html).toContain('data-search-window-current');
  expect(html).toContain('Window 1');
  expect(html).toContain('data-search-coverage');
  expect(html).toContain('@mira');
  expect(html).toContain('/en/@mira');
  expect(html).toContain('Mira Reading Room');
  expect(html).toContain('Mira’s Atlas');
  expect(html).not.toContain('data-search-recovery');
});

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search?q=Mira' });
const globals = {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('mounted recovery uses the host callback and focus refs, and replacement retires the old visible rows', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const regionRef = createRef<HTMLElement>(),
    retryRef = createRef<HTMLButtonElement>();
  let retries = 0;
  const callbacks = {
    regionRef,
    retryRef,
    captureRetryFocus: (button: HTMLButtonElement) => expect(button).toBe(retryRef.current),
  };
  try {
    await act(async () =>
      root.render(
        <SearchResultsRegion
          {...props}
          retryFocus={callbacks}
          data={{ ...props.data!, recovery: { status: 'unavailable' } }}
          onRetry={() => retries++}
        />,
      ),
    );
    expect(regionRef.current).toBe(host.querySelector('[data-search-results]'));
    expect(host.textContent).toContain('Mira Reading Room');
    expect(retries).toBe(0);
    await act(async () => retryRef.current!.click());
    expect(retries).toBe(1);
    await act(async () =>
      root.render(
        <SearchResultsRegion
          {...props}
          retryFocus={callbacks}
          data={{ ...props.data!, discovery: undefined, recovery: { status: 'session' } }}
        />,
      ),
    );
    expect(host.textContent).toContain(m.search_recovery_session({}, { locale: 'en' }));
    expect(host.textContent).not.toContain('Mira Reading Room');
    expect(retryRef.current).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
