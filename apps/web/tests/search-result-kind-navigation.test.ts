import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { DiscoveryResults } from '../src/search/discovery-results';
import { isCatalogueHit } from '../src/search/discovery';
import { ResultRow } from '../src/search/results';

const app = join(import.meta.dir, '..');

// Deferred browser acceptance; only the route's returned data is controlled here.
test('default mixed SearchPage offers direct result-kind navigation that retains other constraints and resets continuation', async () => {
  const directory = join(app, '../../.temp/search-result-kind-navigation');
  await mkdir(directory, { recursive: true });
  const entry = join(directory, 'entry.tsx');
  await writeFile(
    entry,
    `
    import React from ${JSON.stringify(Bun.resolveSync('react', app))};
    import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', app))};
    import { QueryClient, QueryClientProvider } from ${JSON.stringify(Bun.resolveSync('@tanstack/react-query', app))};
    import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from ${JSON.stringify(Bun.resolveSync('@tanstack/react-router', app))};
    import { SearchPage } from ${JSON.stringify(join(app, 'src/search/search.tsx'))};
    import { searchLoaderDeps } from ${JSON.stringify(join(app, 'src/search/search-params.ts'))};
    import { conditionMetadata } from ${JSON.stringify(join(app, 'src/search/condition-editor-model.ts'))};
    import { discoveryExample } from ${JSON.stringify(join(app, 'src/kernel/fake/search-discovery.ts'))};
    import release from ${JSON.stringify(join(app, 'src/kernel/recorded/definitions-release.json'))};
    import { setLocale } from ${JSON.stringify(join(app, 'src/paraglide/runtime.js'))};
    setLocale('en', { reload: false });
    const parseSearch = value => {
      const params = new URLSearchParams(value);
      return Object.fromEntries([...new Set(params.keys())].map(key => [key,
        params.getAll(key).length === 1 ? params.get(key) : params.getAll(key)]));
    };
    const params = new URLSearchParams({ q: '  Mira | 星 + / =  ', type: 'schema:CreativeWork',
      sort: 'rating', filter: ' {"not":{"type":{"in":["schema:Movie"]}}} ',
      condition: JSON.stringify({ or: [{ type: { in: ['schema:Book'] } },
        { not: { statement: { property: 'schema:genre', in: ['mystery'] } } }] }),
      'r.schema:numberOfPages': JSON.stringify({ gte: 1000001, unit: '1' }),
      cursor: 'signed-result+/=' });
    params.append('language', 'ja');
    params.append('language', 'en');
    params.append('f.type', 'schema:Book');
    params.append('f.schema:genre', 'fiction');
    params.append('f.schema:genre', 'science + / =');
    const route = createRootRoute({ component: () => {
      const state = searchLoaderDeps(route.useSearch());
      return <SearchPage query={state.query} data={{
        queryState: state, type: state.type, typeLabels: { en: 'Creative work' }, condition: state.condition,
        conditionMetadata: conditionMetadata(release.release), ranges: state.ranges,
        selectedFacets: state.facets, selectedFacetLabels: {}, groups: [], typeChoices: [],
        hitTypes: {}, yearProperties: [], facetsAvailable: true, facetRetry: false,
        facetIndexNotReady: false, staleCursorRestarted: false, sort: state.sort ?? 'relevance',
        discovery: { status: 'ready', page: { ...discoveryExample,
          next: 'signed-next+/=', kinds: { ...discoveryExample.kinds, next: 'signed-kind-page+/=' } } }
      }} />;
    }, validateSearch: value => value });
    const stringifySearch = search => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(search))
        for (const item of Array.isArray(value) ? value : [value])
          if (typeof item === 'string') params.append(key, item);
      return params.size ? '?' + params : '';
    };
    const router = createRouter({ routeTree: route, parseSearch, stringifySearch,
      history: createMemoryHistory({ initialEntries: ['/en/search?' + params] }) });
    window.kindRouter = router;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await router.load();
    createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  `,
  );
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    plugins: [
      {
        name: 'request-environment',
        setup(build) {
          build.onResolve({ filter: /^@tanstack\/react-start(?:\/server)?$/ }, () => ({
            path: join(app, '.storybook/react-start.ts'),
          }));
          build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: 'request-env',
            namespace: 'request-env',
          }));
          build.onLoad({ filter: /.*/, namespace: 'request-env' }, () => ({
            contents: 'export const env = {};',
            loader: 'js',
          }));
        },
      },
    ],
  });
  expect(result.success, result.logs.map(String).join('\n')).toBe(true);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('https://site.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<main id="app"></main>' }),
    );
    await page.goto('https://site.test/en/search');
    await page.addScriptTag({ type: 'module', content: await result.outputs[0]!.text() });
    const navigation = page.getByRole('navigation', { name: 'Result types', exact: true });
    await navigation.waitFor();
    await page.waitForFunction(
      () => document.querySelector('button[aria-controls="search-filters"]')?.getAttribute('aria-expanded') === 'false',
    );
    const original = await page.evaluate(() => (window as any).kindRouter.state.location.search);
    const account = navigation.getByRole('link', { name: 'Account', exact: true });
    const all = navigation.getByRole('link', { name: 'All', exact: true });
    expect(await all.getAttribute('aria-current')).toBe('page');
    const destination = new URL((await account.getAttribute('href'))!, 'https://site.test');
    expect(destination.pathname).toBe('/en/search');
    expect(destination.searchParams.get('kinds')).toBe('account');
    expect(destination.searchParams.has('cursor')).toBe(false);
    for (const [key, value] of Object.entries(original)) {
      if (key === 'cursor') continue;
      expect(destination.searchParams.getAll(key)).toEqual(Array.isArray(value) ? value : [value]);
    }
    // Modified activation retains the real destination without changing this router.
    expect(
      await account.evaluate((anchor) =>
        anchor.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
          }),
        ),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => (window as any).kindRouter.state.location.search)).toEqual(original);
    await account.click();
    await page.waitForFunction(() => (window as any).kindRouter.state.location.search.kinds === 'account');
    expect(await page.evaluate(() => (window as any).kindRouter.state.location.search)).toEqual({
      ...original,
      kinds: 'account',
      cursor: undefined,
    });
    expect(await account.getAttribute('aria-current')).toBe('page');
    expect(await all.getAttribute('aria-current')).toBeNull();
    await all.click();
    await page.waitForFunction(() => !(window as any).kindRouter.state.location.search.kinds);
    expect(await page.evaluate(() => (window as any).kindRouter.state.location.search)).toEqual({
      ...original,
      cursor: undefined,
    });

    // A paged metadata response lacks one exact selection made through Filters.
    await page.evaluate(async () => {
      const router = (window as any).kindRouter;
      await router.navigate({
        search: {
          ...router.state.location.search,
          kinds: ['schema:Book', 'catalogue:Atlas'],
          cursor: 'signed-multi+/=',
        },
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await navigation.getByText('Selected result types: Book, catalogue:Atlas', { exact: true }).waitFor();
    expect(await all.getAttribute('aria-current')).toBeNull();
    expect(await navigation.getByRole('link', { name: 'catalogue:Atlas', exact: true }).isVisible()).toBe(true);
    expect(await navigation.getByText('Choose more result types in Filters.', { exact: true }).isVisible()).toBe(true);
    const exact = new URL(
      (await navigation.getByRole('link', { name: 'Book', exact: true }).getAttribute('href'))!,
      'https://site.test',
    );
    expect(exact.searchParams.getAll('kinds')).toEqual(['schema:Book']);
    await all.click();
    await page.waitForFunction(() => !(window as any).kindRouter.state.location.search.kinds);
    expect(await page.evaluate(() => (window as any).kindRouter.state.location.search)).toEqual({
      ...original,
      cursor: undefined,
    });
    expect(await all.getAttribute('aria-current')).toBe('page');
    expect(await page.getByRole('button', { name: /^Filters \(/ }).getAttribute('aria-expanded')).toBe('false');
  } finally {
    await browser.close();
  }
});

test('mixed discovery keeps subject and account destinations distinct while subject facts remain secondary links', () => {
  const page = structuredClone(discoveryExample);
  const subject = page.hits.find((hit) => hit.summary.kind === 'subject' && hit.key.kind === 'schema:Book')!;
  if (!isCatalogueHit(subject)) throw new Error('Expected the public Book fixture');
  subject.descriptions = { en: 'An atlas of reading journeys.' };
  subject.aliases = { en: ['Reading atlas'] };
  subject.facts = { 'schema:author': [{ kind: 'item', id: page.hits[0]!.key.id, labels: { en: 'Mira' } }] };
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, { state: { status: 'ready', page }, locale: 'en' }),
  );
  expect(html.match(/<li\b/g)).toHaveLength(4);
  expect(html).toContain('href="/en/@mira"');
  expect(html).toContain(`href="/en/subjects/${subject.key.id}/mira-s-atlas"`);
  const bookRow = html.split('<li').find((row) => row.includes('Mira’s Atlas'))!;
  expect(bookRow.match(/data-slot="list-row-link"/g)).toHaveLength(1);
  const primary = bookRow.match(/<a\b[^>]*data-slot="list-row-link"[^>]*>[\s\S]*?<\/a>/)![0];
  expect(primary).toContain('Mira’s Atlas');
  expect(primary).not.toContain('Reading atlas');
  expect(primary).not.toContain('An atlas of reading journeys.');
  expect(primary.match(/<a\b/g)).toHaveLength(1);
  expect(bookRow).toContain(`href="/en/subjects/${page.hits[0]!.key.id}/mira"`);
  expect(bookRow).toContain('data-content-item-slot="metadata"');
  expect(bookRow).toContain('data-content-item-slot="preview"');
});

test('actual result cover composition keeps released frame geometry and independent suitability controls', () => {
  const id = '00000000-0000-4000-8000-000000000813';
  for (const [imageAspect, ratio, width] of [
    ['portrait', '5:7', 'w-[72px] sm:w-24'],
    ['landscape', '16:9', 'w-32 sm:w-48'],
    ['square', '1:1', 'w-[72px] sm:w-24'],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(ResultRow, {
        hit: {
          id,
          type: 'schema:Book',
          labels: { en: 'Mira’s Atlas' },
          listPresentation: { imageAspect, keyFacts: [] },
          summary: {
            id,
            type: 'schema:Book',
            cover: {
              media: '00000000-0000-4000-8000-000000000999',
              width: 900,
              height: 1260,
              placeholder: { color: '#465c72', thumbhash: '' },
              variants: [{ format: 'webp', width: 640 }],
              focalPoint: null,
              credit: null,
              withheld: 'suitability',
            },
          },
        },
        locale: 'en',
        hitTypes: {},
        yearProperties: [],
      }),
    );
    expect(html).toContain(`data-ratio="${ratio}"`);
    expect(html).toContain(width);
    expect(html).toContain('data-state="withheld"');
    expect(html).toContain('Show cover');
    expect(html).toContain('[&amp;_button]:z-10');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<source');
    const primary = html.match(/<a\b[^>]*data-slot="list-row-link"[^>]*>[\s\S]*?<\/a>/)![0];
    expect(primary).not.toContain('<button');
    expect(html.match(/<button\b/g)).toHaveLength(1);
  }
});
