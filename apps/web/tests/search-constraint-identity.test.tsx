import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const app = join(import.meta.dir, '..');

// Authored actual-renderer acceptance, UNRUN. SDK responses and authority transitions are fixtures;
// this does not prove native admission, SSR, page bounds, or visual acceptance.
test('selected Search identities retain exact operands, local keyboard actions and current authority without label hydration', async () => {
  const directory = join(app, '../../.temp/search-constraint-identity');
  await mkdir(directory, { recursive: true });
  const entry = join(directory, 'entry.tsx');
  await writeFile(
    entry,
    `
    import React, { useState } from ${JSON.stringify(Bun.resolveSync('react', app))};
    import { createRoot } from ${JSON.stringify(Bun.resolveSync('react-dom/client', app))};
    import { QueryClient, QueryClientProvider } from ${JSON.stringify(Bun.resolveSync('@tanstack/react-query', app))};
    import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from ${JSON.stringify(Bun.resolveSync('@tanstack/react-router', app))};
    import { createKernelClient } from ${JSON.stringify(Bun.resolveSync('@rezics/client', app))};
    import { SearchPage } from ${JSON.stringify(join(app, 'src/search/search.tsx'))};
    import { searchLoaderDeps, discoverySearchHref } from ${JSON.stringify(join(app, 'src/search/search-params.ts'))};
    import { discoveryRequest } from ${JSON.stringify(join(app, 'src/search/search-request.ts'))};
    import { readSearchOutcome } from ${JSON.stringify(join(app, 'src/search/search-recovery.ts'))};
    import { conditionMetadata } from ${JSON.stringify(join(app, 'src/search/condition-editor-model.ts'))};
    import release from ${JSON.stringify(join(app, 'src/kernel/recorded/definitions-release.json'))};
    import { m } from ${JSON.stringify(join(app, 'src/paraglide/messages.js'))};
    import { setLocale } from ${JSON.stringify(join(app, 'src/paraglide/runtime.js'))};
    setLocale('en', { reload: false });
    const long = '長い名前 · 긴 이름 · Erinnerungen · mémoires '.repeat(12);
    const initial = searchLoaderDeps({ q: '  Mira | 星  ', type: 'schema:Book', kinds: ['schema:Book', 'account'],
      language: ['ja', 'en'], cursor: 'native+/= opaque',
      'f.schema:genre': ['fixture:genre-a', 'fixture:genre-b'],
      'r.schema:datePublished': JSON.stringify({ gte: 1900 }),
      'r.fixture:amount': JSON.stringify({ gte: -12.5, lte: 99, unit: 'fixture:opaque-unit' }),
      condition: JSON.stringify({ not: { type: { in: ['schema:Movie'] } } }),
      filter: JSON.stringify({ type: { in: ['schema:CreativeWork'] } }) });
    const page = { as_of: '2026-11-02T00:00:00Z', hits: [], next: null, kinds: { next: null, values: [
      { id: 'schema:Book', labels: { en: 'Current kind label' }, icon: 'book' },
      { id: 'account', labels: { en: '   ' }, icon: 'user' }
    ] } };
    const requests = [];
    const expected = discoveryRequest(initial, ['en']);
    const sdk = createKernelClient('https://kernel.fixture', { headers: { authorization: 'Bearer original-session' }, fetch: async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init.body)), credential: new Headers(init.headers).get('authorization') });
      return Response.json(page);
    } });
    const first = await readSearchOutcome(expected, body => sdk.subjects.$search.post(body));
    const parseSearch = value => {
      const params = new URLSearchParams(value);
      return Object.fromEntries([...new Set(params.keys())].map(key => [key, params.getAll(key).length === 1 ? params.get(key) : params.getAll(key)]));
    };
    const stringifySearch = search => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(search))
        for (const item of Array.isArray(value) ? value : [value]) if (typeof item === 'string') params.append(key, item);
      return params.size ? '?' + params : '';
    };
    const api = { requests, expected, initial, long, router: undefined, mode: undefined, authority: undefined, retire: undefined, finish: undefined, retired: false };
    window.identity = api;
    const route = createRootRoute({ validateSearch: value => value, component: () => {
      const state = searchLoaderDeps(route.useSearch());
      const [presentation, setPresentation] = useState({ mode: 'missing' });
      const mode = presentation.mode;
      const [outcome, setOutcome] = useState(first);
      api.mode = (value, locale = 'en') => { setLocale(locale, { reload: false }); setOutcome(first); setPresentation({ mode: value }); };
      api.authority = status => setOutcome({ recovery: { status } });
      api.retire = () => {
        const controller = new AbortController();
        const deferred = new Promise(resolve => { api.finish = () => resolve({ status: 200, data: page }); });
        void readSearchOutcome(expected, () => deferred, controller.signal).then(setOutcome, () => { api.retired = true; });
        controller.abort();
        setOutcome({ recovery: { status: 'denied' } });
      };
      const metadata = conditionMetadata(release.release);
      metadata.properties['schema:datePublished'].labels = { en: 'Publication year' };
      metadata.properties['schema:genre'].labels = known || mixed ? { en: 'Current property label' } : {};
      const known = mode === 'known';
      const mixed = mode === 'mixed';
      const facets = mode === 'many' ? { ...state.facets, 'fixture:missing': Array.from({ length: 24 }, (_, index) => 'fixture:' + index + '-' + '長い値'.repeat(32)) } : state.facets;
      return <SearchPage query={state.query} cursor={state.cursor} data={{
        ...outcome, queryState: { ...state, facets }, type: state.type, typeLabels: known || mixed ? { en: 'Book' } : {},
        conditionMetadata: known || mixed ? metadata : undefined, condition: state.condition, ranges: state.ranges,
        selectedFacets: facets, selectedFacetLabels: known || mixed ? { 'schema:genre': {
          'fixture:genre-a': { text: long, lang: 'en' },
          ...(known ? { 'fixture:genre-b': { text: 'Mystery', lang: 'en' } } : {})
        } } : {},
        hitTypes: {}, yearProperties: [], typeChoices: [], groups: [], facetsAvailable: true, facetRetry: false,
        facetIndexNotReady: false, staleCursorRestarted: false, sort: 'relevance',
        discovery: outcome.recovery.status === 'ready' ? { status: 'ready', page: { ...page, kinds: { ...page.kinds,
          values: page.kinds.values.map(kind => ({ ...kind, labels: known || mixed ? kind.labels : {} })) } } } : undefined,
        refinement: { key: JSON.stringify(state), properties: [], initial: { status: 'ready', page: { as_of: page.as_of, facets: [
          { property: 'schema:genre', next: null, values: [
            { value: 'fixture:genre-a', labels: known || mixed ? { en: long } : {} },
            { value: 'fixture:genre-b', labels: known ? { en: 'Mystery' } : {} }
          ] }
        ] } } }
      }} />;
    } });
    const router = createRouter({ routeTree: route, parseSearch, stringifySearch,
      history: createMemoryHistory({ initialEntries: [discoverySearchHref('en', initial)] }) });
    api.router = router;
    api.labels = () => ({ kind: m.search_constraint_identity_kind_unavailable(), property: m.search_constraint_identity_property_unavailable(),
      value: m.search_constraint_identity_value_unavailable(), unit: m.search_constraint_identity_unit_unavailable() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await router.load();
    createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  `,
  );
  const bundle = await Bun.build({
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
  expect(bundle.success, bundle.logs.map(String).join('\n')).toBe(true);
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route('https://site.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<div id="app"></div>' }),
      );
      await page.goto('https://site.test/en/search');
      await page.addScriptTag({ type: 'module', content: await bundle.outputs[0]!.text() });
      const selected = page.locator('[data-search-constraints]');
      await selected.waitFor();
      const links = selected.getByRole('link');
      expect(await links.count()).toBe(11);
      const labels = await page.evaluate(() => (window as any).identity.labels());
      for (const label of Object.values(labels)) expect(await selected.textContent()).toContain(label as string);
      expect(await selected.textContent()).not.toMatch(/schema:|fixture:|account/);
      expect(
        new Set(await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))).size,
      ).toBe(11);
      // Every link removes exactly its own selected operand and resets only continuation.
      const initial = await page.evaluate(() => (window as any).identity.initial);
      for (let index = 0; index < 11; index++) {
        const url = new URL((await links.nth(index).getAttribute('href'))!, 'https://site.test');
        expect(url.searchParams.get('q')).toBe(initial.query);
        expect(url.searchParams.get('cursor')).toBeNull();
        expect(url.searchParams.get('type')).toBe(index === 0 ? null : initial.type);
        expect(url.searchParams.getAll('kinds')).toEqual(
          index === 1 ? ['account'] : index === 2 ? ['schema:Book'] : initial.kinds,
        );
        expect(url.searchParams.getAll('f.schema:genre')).toEqual(
          index === 3 ? ['fixture:genre-b'] : index === 4 ? ['fixture:genre-a'] : initial.facets['schema:genre'],
        );
        for (const [offset, property] of ['schema:datePublished', 'fixture:amount'].entries())
          expect(url.searchParams.get('r.' + property)).toBe(
            index === offset + 5 ? null : JSON.stringify(initial.ranges[property]),
          );
        expect(url.searchParams.getAll('language')).toEqual(
          index === 7 ? ['en'] : index === 8 ? ['ja'] : initial.languages,
        );
        expect(url.searchParams.get('condition')).toBe(index === 9 ? null : JSON.stringify(initial.condition));
        expect(url.searchParams.get('filter')).toBe(index === 10 ? null : initial.filter);
      }
      const details = page.locator('[data-search-constraint-details]');
      const summary = details.locator('summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      expect(await details.getAttribute('open')).not.toBeNull();
      const exact = await details.locator('code').allTextContents();
      expect(exact.map((text) => JSON.parse(text))).toEqual([
        { type: initial.type },
        ...initial.kinds.map((kind: string) => ({ kind })),
        ...initial.facets['schema:genre'].map((value: string) => ({ property: 'schema:genre', value })),
        ...Object.entries(initial.ranges).map(([property, range]) => ({ property, range })),
      ]);
      for (const code of await details.locator('code').all()) {
        await code.focus();
        expect(await code.evaluate((node) => node === document.activeElement)).toBe(true);
        expect(await code.getAttribute('class')).toContain('select-text');
        expect(await code.getAttribute('class')).toContain('whitespace-pre-wrap');
        expect(await code.getAttribute('class')).toContain('wrap-anywhere');
      }
      await summary.focus();
      await page.keyboard.press('Space');
      expect(await details.getAttribute('open')).toBeNull();
      // All catalog labels render; supplied long multilingual names keep their meaning.
      for (const locale of ['de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant', 'en']) {
        await page.evaluate((locale) => (window as any).identity.mode('missing', locale), locale);
        await page.waitForFunction(() =>
          document
            .querySelector('[data-search-constraints]')
            ?.textContent?.includes((window as any).identity.labels().kind),
        );
        const localized = await page.evaluate(() => (window as any).identity.labels());
        for (const label of Object.values(localized)) expect(await selected.textContent()).toContain(label as string);
      }
      await page.evaluate(() => (window as any).identity.mode('known'));
      await page.getByRole('link', { name: /Current property label:.*Mystery/ }).waitFor();
      expect(await selected.textContent()).toContain('Publication year: 1900 – …');
      expect(await selected.textContent()).toContain(await page.evaluate(() => (window as any).identity.long));
      await page.evaluate(() => (window as any).identity.mode('mixed'));
      await page.getByRole('link', { name: /Current property label: Value name unavailable/ }).waitFor();
      expect(await selected.textContent()).toContain('Book');
      expect(await selected.textContent()).toContain('Type name unavailable');
      // Current authority masks protected metadata even in closed technical details.
      for (const status of ['session', 'closed', 'denied', 'restart']) {
        await page.evaluate((status) => (window as any).identity.authority(status), status);
        await page.locator('[data-search-recovery="' + status + '"]').waitFor();
        expect(await page.locator('#app').innerHTML()).not.toMatch(
          /Current property label|Current kind label|長い名前/,
        );
        expect(await details.textContent()).toContain('fixture:genre-a');
        await page.evaluate(() => (window as any).identity.mode('mixed'));
        await page.getByRole('link', { name: /Current property label: Value name unavailable/ }).waitFor();
      }
      await page.evaluate(() => {
        const api = (window as any).identity;
        api.retire();
        api.finish();
      });
      await page.waitForFunction(() => (window as any).identity.retired);
      expect(await page.locator('[data-search-recovery="denied"]').count()).toBe(1);
      expect(await page.locator('#app').innerHTML()).not.toMatch(/Current property label|Current kind label|長い名前/);
      await page.evaluate(() => (window as any).identity.mode('many'));
      await page.waitForFunction(
        () => document.querySelector('[data-search-constraints]')?.querySelectorAll('a').length === 35,
      );
      expect(await details.textContent()).toContain('fixture:23-' + '長い値'.repeat(32));
      await summary.focus();
      await page.keyboard.press('Enter');
      expect(await details.locator('code').last().getAttribute('class')).toContain('wrap-anywhere');
      expect(await selected.locator('.truncate').count()).toBe(0);
      await page.evaluate(() => (window as any).identity.mode('missing'));
      await page.waitForFunction(
        () => document.querySelector('[data-search-constraints]')?.querySelectorAll('a').length === 11,
      );
      // No clear-all action is introduced: clear the entire selection through existing keyboard links.
      for (let remaining = 11; remaining > 0; remaining--) {
        await links.first().focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          (count) => (document.querySelector('[data-search-constraints]')?.querySelectorAll('a').length ?? 0) === count,
          remaining - 1,
        );
      }
      expect(await details.count()).toBe(0);
      expect(await page.evaluate(() => (window as any).identity.router.state.location.search.q)).toBe(initial.query);
      const requests = await page.evaluate(() => (window as any).identity.requests);
      expect(requests).toEqual([
        {
          url: 'https://kernel.fixture/v1/subjects:search',
          body: await page.evaluate(() => (window as any).identity.expected),
          credential: 'Bearer original-session',
        },
      ]);
      expect(requests[0].body.limit).toBe(100);
      expect(requests[0].body.kindPage).toEqual({ limit: 8 });
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
