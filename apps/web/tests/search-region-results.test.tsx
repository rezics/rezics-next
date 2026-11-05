import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { SearchResultsRegion, type SearchResultsRegionProps } from '../src/search/search-regions/results';
import { m } from '../src/paraglide/messages.js';
import { searchFilterWithScope } from '../src/search/advanced-scope';
import { searchPageForRecovery } from '../src/search/search-recovery';
import { discoverySearchHref, type SearchLoaderDeps } from '../src/search/search-params';
import { conditionMetadata } from '../src/search/condition-editor-model';
import release from '../src/kernel/recorded/definitions-release.json';

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

test('mounted result context stays on the executed request through draft edits and retires disclosed labels with authority', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const scope = { kind: 'collection', id: '019a1b2c-3d4e-7f00-8a00-5ab1ec700001' } as const;
  const privateLabelId = '11111111-1111-4111-8111-111111111111';
  const privateOwnerIds = [
    'private-profile',
    'private-state-set',
    'private-state',
    privateLabelId,
    'private-session-profile',
    'private-holding-profile',
    'private-holding-kind',
    'private-holding-status',
  ];
  const filter = searchFilterWithScope(
    JSON.stringify({
      and: [
        { type: { in: ['schema:Book'] } },
        { owner: { presence: true } },
        { owner: { state: { profileId: 'private-profile', stateSetId: 'private-state-set', in: ['private-state'] } } },
        { owner: { label: { id: privateLabelId } } },
        { owner: { session: { profileId: 'private-session-profile', lifecycle: 'abandoned' } } },
        {
          owner: {
            holding: {
              profileId: 'private-holding-profile',
              kind: 'private-holding-kind',
              status: 'private-holding-status',
            },
          },
        },
      ],
    }),
    scope,
  )!;
  const executed: SearchLoaderDeps = {
    query: 'Executed query',
    type: 'schema:Book',
    kinds: ['schema:Book'],
    facets: { 'schema:genre': ['fiction', 'en'], 'schema:inLanguage': ['en'] },
    languages: ['ja', 'en'],
    condition: {
      and: [
        { not: { type: { in: ['schema:Movie'] } } },
        {
          statement: {
            property: 'schema:genre',
            in: ['fiction', 'en'],
            qualifiers: [{ property: 'schema:authorRole', in: ['writer'] }],
          },
        },
      ],
    },
    filter,
    resourceScope: scope,
    cursor: 'old-checkpoint',
    sort: undefined,
  };
  const metadata = conditionMetadata(release.release);
  metadata.types['schema:Book']!.labels = { en: 'Catalogue Book' };
  metadata.properties['schema:genre']!.labels = { en: 'Genre' };
  metadata.properties['schema:inLanguage']!.labels = { en: 'Language property' };
  const data = {
    ...props.data!,
    queryState: executed,
    conditionMetadata: metadata,
    selectedFacets: executed.facets,
    selectedFacetLabels: { 'schema:genre': { fiction: { text: 'Fiction', lang: 'en' } } },
    typeLabels: { en: 'Catalogue Book' },
    typeChoices: [{ id: 'schema:Book', labels: { en: 'Exact Book choice' } }],
    hitTypes: { 'schema:Book': { en: 'Exact Book' } },
  };
  try {
    await act(async () =>
      root.render(
        <SearchResultsRegion
          {...props}
          query="Draft query"
          data={data}
          retryState={executed}
          onRetry={() => undefined}
        />,
      ),
    );
    const coverage = host.querySelector('[data-search-coverage]')!;
    expect(coverage.textContent).toContain('Executed query');
    expect(coverage.textContent).not.toContain('Draft query');
    expect(coverage.textContent).toContain('Collection scope: 019a1b2c-3d4e-7f00-8a00-5ab1ec700001');
    expect(coverage.textContent).toContain('Title and description language preferences, in this order: Japanese, English');
    expect(coverage.textContent).toContain('Catalogue Type (including released subtypes)');
    expect(coverage.textContent).toContain('Catalogue Book');
    expect(coverage.textContent).toContain('Exact discovery Type');
    expect(coverage.textContent).toContain('Exact Book');
    expect(coverage.textContent).toContain('Genre: Fiction, en');
    expect(coverage.textContent).not.toContain('Genre: Fiction, Genre');
    expect(coverage.textContent).toContain('Language property: en');
    expect(coverage.textContent).toContain('personal record');
    expect(coverage.textContent).toContain('state set');
    expect(coverage.textContent).toContain('selected personal label');
    expect(coverage.textContent).toContain('Session lifecycle: abandoned');
    expect(coverage.textContent).toContain('profile, kind, status');
    for (const privateId of privateOwnerIds) expect(coverage.textContent).not.toContain(privateId);

    const refresh = host.querySelector<HTMLAnchorElement>('[data-search-coverage] a')!;
    const refreshUrl = new URL(refresh.href, 'https://search.test');
    expect(refreshUrl.searchParams.get('q')).toBe(executed.query);
    expect(refreshUrl.searchParams.get('filter')).toBe(filter);
    expect(refreshUrl.searchParams.getAll('language')).toEqual(['ja', 'en']);
    expect(refreshUrl.searchParams.has('cursor')).toBe(false);
    expect(refresh.getAttribute('href')).toBe(discoverySearchHref('en', { ...executed, cursor: undefined }));

    const retired = searchPageForRecovery(
      {
        ...data,
        hitTypes: { private: { en: 'Retired private Type label' } },
        selectedFacetLabels: { private: { value: { text: 'Retired private value label', lang: 'en' } } },
      },
      { status: 'session' },
    );
    expect(retired.hitTypes).toEqual({});
    expect(retired.selectedFacetLabels).toEqual({});
    await act(async () =>
      root.render(
        <SearchResultsRegion
          {...props}
          data={retired}
          retryState={executed}
          onRetry={() => undefined}
        />,
      ),
    );
    expect(host.querySelector('[data-search-coverage]')).toBeNull();
    expect(host.textContent).not.toContain('Retired private Type label');
    expect(host.textContent).not.toContain('Retired private value label');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
