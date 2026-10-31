import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

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
      condition: JSON.stringify({ or: [{ type: { in: ['schema:Book'], descendants: true } },
        { not: { statement: { property: 'schema:genre', in: ['mystery'] } } }] }),
      'r.schema:numberOfPages': JSON.stringify({ gt: 1000000, unit: 'page' }),
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
    const navigation = page.getByRole('navigation', { name: 'Result kinds', exact: true });
    await navigation.waitFor();
    await page.waitForFunction(
      () => document.querySelector('button[aria-controls="search-filters"]')?.getAttribute('aria-expanded') === 'false',
    );
    const original = await page.evaluate(() => (window as any).kindRouter.state.location.search);
    const account = navigation.getByRole('link', { name: 'Account', exact: true });
    const all = navigation.getByRole('link', { name: 'All result kinds', exact: true });
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
    expect(await account.evaluate((anchor) => anchor.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, ctrlKey: true,
    })))).toBe(true);
    expect(await page.evaluate(() => (window as any).kindRouter.state.location.search)).toEqual(original);
    await account.click();
    await page.waitForFunction(() => (window as any).kindRouter.state.location.search.kinds === 'account');
    expect(await page.evaluate(() => (window as any).kindRouter.state.location.search)).toEqual({
      ...original, kinds: 'account', cursor: undefined,
    });
    expect(await account.getAttribute('aria-current')).toBe('page');
    expect(await all.getAttribute('aria-current')).toBeNull();
    await all.click();
    await page.waitForFunction(() => !(window as any).kindRouter.state.location.search.kinds);
    expect(await page.evaluate(() => (window as any).kindRouter.state.location.search)).toEqual({
      ...original, cursor: undefined,
    });

    // A paged metadata response lacks one exact selection made through Filters.
    await page.evaluate(async () => {
      const router = (window as any).kindRouter;
      await router.navigate({ search: { ...router.state.location.search,
        kinds: ['schema:Book', 'catalogue:Atlas'], cursor: 'signed-multi+/=' } });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await navigation.getByText('Selected result kinds: Book, catalogue:Atlas', { exact: true }).waitFor();
    expect(await all.getAttribute('aria-current')).toBeNull();
    expect(await navigation.getByRole('link', { name: 'catalogue:Atlas', exact: true }).isVisible()).toBe(true);
    expect(await navigation.getByText('Choose more result kinds in Filters.', { exact: true }).isVisible()).toBe(true);
    const exact = new URL((await navigation.getByRole('link', { name: 'Book', exact: true }).getAttribute('href'))!, 'https://site.test');
    expect(exact.searchParams.getAll('kinds')).toEqual(['schema:Book']);
    await all.click();
    await page.waitForFunction(() => !(window as any).kindRouter.state.location.search.kinds);
    expect(await page.evaluate(() => (window as any).kindRouter.state.location.search)).toEqual({
      ...original, cursor: undefined,
    });
    expect(await all.getAttribute('aria-current')).toBe('page');
    expect(await page.getByRole('button', { name: /^Filters \(/ }).getAttribute('aria-expanded')).toBe('false');
  } finally {
    await browser.close();
  }
});
