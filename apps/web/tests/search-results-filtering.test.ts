import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const app = join(import.meta.dir, '..');

// Deferred browser acceptance: mount the real default composition, controlling only loader data.
test('default SearchPage exposes reachable result filters without an empty column and truthful kind/type selection', async () => {
  const directory = join(app, '../../.temp/search-results-filtering');
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
    import release from ${JSON.stringify(join(app, 'src/kernel/recorded/definitions-release.json'))};
    import { setLocale } from ${JSON.stringify(join(app, 'src/paraglide/runtime.js'))};
    setLocale('en', { reload: false });
    const parseSearch = value => {
      const params = new URLSearchParams(value);
      return Object.fromEntries([...new Set(params.keys())].map(key => [key,
        params.getAll(key).length === 1 ? params.get(key) : params.getAll(key)]));
    };
    const condition = { not: { type: { in: ['schema:Movie'] } } };
    const params = new URLSearchParams({ q: '  reading | 星  ', type: 'schema:Book', language: 'ja',
      condition: JSON.stringify(condition), filter: JSON.stringify({ type: { in: ['schema:CreativeWork'] } }),
      'r.schema:datePublished': JSON.stringify({ gte: 1900 }), cursor: 'signed+/=' });
    const route = createRootRoute({ component: () => {
      const state = searchLoaderDeps(route.useSearch());
      return <SearchPage query={state.query} data={{
        queryState: state, type: state.type, typeLabels: { en: 'Book' }, condition: state.condition,
        conditionMetadata: conditionMetadata(release.release), ranges: state.ranges,
        selectedFacets: state.facets, selectedFacetLabels: {}, groups: [], typeChoices: [],
        hitTypes: {}, yearProperties: [], facetsAvailable: true, facetRetry: false,
        facetIndexNotReady: false, staleCursorRestarted: false, sort: 'relevance',
        refinement: { key: JSON.stringify(state), properties: [{ property: 'type', labels: {}, mode: 'types', datatype: 'type', units: [] }],
          initial: { status: 'ready', page: { as_of: '2026-11-01T00:00:00Z', facets: [
            { property: 'type', values: [{ value: 'schema:Book', labels: { en: 'Book' } }], next: null }
          ] } } },
        discovery: { status: 'ready', page: { hits: [], next: 'signed-next+/=', as_of: '2026-11-01T00:00:00Z', kinds: {
          values: [{ id: 'schema:Book', labels: { en: 'Book' }, icon: 'book' },
            { id: 'account', labels: { en: 'Account' }, icon: 'user' }], next: 'signed-kinds+/='
        } } }
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
    window.filterRouter = router;
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
    const trigger = page.getByRole('button', { name: /^Filters \(/ });
    await trigger.waitFor();
    await page.waitForFunction(
      () => document.querySelector('button[aria-controls="search-filters"]')?.getAttribute('aria-expanded') === 'false',
    );
    const results = page.getByText('Results', { exact: true });
    expect(
      Math.abs((await results.boundingBox())!.x - (await page.getByRole('heading', { level: 1 }).boundingBox())!.x),
    ).toBeLessThan(8);
    await trigger.click();
    const panel = page.getByRole('region', { name: 'Filters', exact: true });
    await panel.waitFor();
    expect(await panel.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    const subjectType = panel.getByRole('combobox', { name: 'Subject type', exact: true });
    expect(await subjectType.inputValue()).toBe('schema:Book');
    expect(await panel.getByText('All result types', { exact: true }).isVisible()).toBe(true);
    expect(await panel.getByRole('checkbox', { name: 'Book', exact: true }).count()).toBe(0);
    await panel.getByText('Choose specific result types', { exact: true }).click();
    await panel.getByRole('checkbox', { name: 'Account results', exact: true }).check();
    await page.waitForFunction(() => (window as any).filterRouter.state.location.search.kinds === 'account');
    expect(await page.getByRole('link', { name: /Type: Account/ }).isVisible()).toBe(true);
    const search = await page.evaluate(() => (window as any).filterRouter.state.location.search);
    expect(search.q).toBe('  reading | 星  ');
    expect(search.language).toBe('ja');
    expect(search.type).toBe('schema:Book');
    expect(JSON.parse(search.condition)).toEqual({ not: { type: { in: ['schema:Movie'] } } });
    expect(JSON.parse(search.filter)).toEqual({ type: { in: ['schema:CreativeWork'] } });
    expect(JSON.parse(search['r.schema:datePublished'])).toEqual({ gte: 1900 });
    expect(search.cursor).toBeUndefined();
    expect(await panel.getByRole('checkbox', { name: 'Account results', exact: true }).isChecked()).toBe(true);
    expect(await subjectType.inputValue()).toBe('schema:Book');
    await page.getByRole('link', { name: 'More results', exact: true }).click();
    await page.waitForFunction(() => (window as any).filterRouter.state.location.search.cursor === 'signed-next+/=');
    expect(await panel.getByRole('checkbox', { name: 'Account results', exact: true }).isChecked()).toBe(true);
  } finally {
    await browser.close();
  }
});
