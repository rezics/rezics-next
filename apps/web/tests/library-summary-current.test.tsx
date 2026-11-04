import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import type { ShelfSummaryCurrentRead, ShelfSummary } from '../src/library/shelf-summary-read';
import type { ShelfOrigin } from '../src/library/personal-shelf-origin';
import { shelfSummaryObservation } from '../src/library/shelf-summary-observation';
import { locales, getLocale, setLocale } from '../src/paraglide/runtime.js';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
let admittedOperations = new Set<string>();
mock.module(Bun.resolveSync('../src/kernel/exposure', import.meta.dir), () => ({
  Exposure: ({ operation, children }: { operation: string; children: ReactNode }) =>
    admittedOperations.has(operation) ? children : null,
}));
afterAll(() => mock.restore());
const reads = await import('../src/library/shelf-summary-read');
const { useShelfSummaryCurrent } = await import('../src/library/shelf-summary-current');
const { ShelfSummaryNavigation, ShelfSummaryCount, ShelfSummaryFirstUseLinks, shelfSummaryFirstUse } =
  await import('../src/library/shelf-summary-view');
const { libraryNavigation } = await import('../src/library/navigation');
const messages = await import('../src/paraglide/messages.js');
const binding = { subject: 'owner', type: null, locale: 'en', source: 'https://site.test/en/library' };
function summary(n = 0): ShelfSummary {
  return {
    tabs: {
      all: { shown: n, total: n },
      in_progress: { shown: 0, total: 0 },
      planned: { shown: n, total: n },
      completed: { shown: 0, total: 0 },
      paused: { shown: 0, total: 0 },
      dropped: { shown: 0, total: 0 },
      collections: { shown: 2, total: 2 },
    },
  };
}
const response = (n = 0): ShelfSummaryCurrentRead => ({
  sessionSubject: binding.subject,
  authorizationAgrees: true,
  requested: { type: binding.type, locale: binding.locale, source: binding.source },
  page: { state: 'loaded', summary: summary(n) },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('one observation deduplicates mounting and discards pre-acknowledgement and retired responses', async () => {
  let current = true;
  let calls = 0;
  const pending = deferred<ShelfSummaryCurrentRead>();
  const observation = shelfSummaryObservation(
    binding,
    () => current,
    () => {
      calls++;
      return pending.promise;
    },
  );
  const first = observation.start();
  observation.start();
  expect(calls).toBe(1);
  observation.invalidate();
  pending.resolve(response(100));
  await first;
  expect(observation.snapshot()).toEqual({ state: 'stale' });
  await observation.refresh();
  expect(observation.snapshot()).toMatchObject({ state: 'loaded' });
  expect(calls).toBe(2);
  current = false;
  await observation.refresh();
  expect(calls).toBe(2);
});

test('mixed account, exact Type, locale, source and credential observations never produce counts', async () => {
  for (const changed of [
    { sessionSubject: 'other' },
    { authorizationAgrees: false },
    { requested: { ...response().requested, type: 'schema:Book' } },
    { requested: { ...response().requested, locale: 'ja' } },
    { requested: { ...response().requested, source: `${binding.source}?state=planned` } },
  ]) {
    const observation = shelfSummaryObservation(
      binding,
      () => true,
      async () => ({ ...response(), ...changed }),
    );
    await observation.start();
    expect(observation.snapshot()).toEqual({ state: 'unavailable' });
  }
  const rows = { signedIn: true as const, entries: [], next: null };
  expect(shelfSummaryFirstUse(response().page, rows)).toBe(true);
  for (const page of [
    { ...rows, readState: 'preparing' as const },
    { ...rows, type: 'schema:Book' },
    { ...rows, state: 'planned' as const },
    { ...rows, next: 'later' },
    { ...rows, signedIn: false as const },
  ])
    expect(shelfSummaryFirstUse(response().page, page)).toBe(false);
  expect(shelfSummaryFirstUse(response().page, rows, 'later')).toBe(false);
  for (const state of ['preparing', 'stale', 'unavailable'] as const)
    expect(shelfSummaryFirstUse({ state }, rows)).toBe(false);
  expect(shelfSummaryFirstUse(response(2).page, rows)).toBe(false);
});

test('eight locales render first-use and count navigation with registered destinations and admission', () => {
  const before = getLocale();
  const previousAdmission = admittedOperations;
  admittedOperations = new Set(['library_entry.put', 'library_label.list', 'collection.list']);
  const client = new QueryClient();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const page = response(4096).page;
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <ShelfSummaryCount page={page} locale={locale} />
          <ShelfSummaryNavigation
            summary={{ page, retry: () => {} }}
            locale={locale}
            view={{
              type: 'schema:Book',
              state: 'planned',
              cursor: 'old',
              orderBy: 'createdAt',
              direction: 'asc',
              layout: 'list',
              size: 'l',
            }}
          />
          <ShelfSummaryFirstUseLinks locale={locale} />
        </QueryClientProvider>,
      );
      expect(html).toContain(new Intl.NumberFormat(locale).format(4096));
      expect(html).toContain(`/${locale}/library?type=schema%3ABook`);
      expect(html).toContain('state=completed');
      expect(html).toContain('orderBy=createdAt');
      expect(html).toContain('direction=asc');
      expect(html).toContain('layout=list');
      expect(html).toContain('size=l');
      expect(html).not.toContain('cursor=');
      expect(html).toContain('aria-current="page"');
      expect(html).toContain('min-h-11 min-w-11');
      expect(html).toContain(messages.library_summary_first_use_guidance({}, { locale }));
      const imports = libraryNavigation.filter((destination) => destination.id.startsWith('library.import-'));
      expect(imports).toHaveLength(4);
      for (const destination of imports) {
        expect(html).toContain(`href="/${locale}${destination.href}"`);
        expect(html).toContain(destination.label({ locale }));
      }
    }
    admittedOperations = new Set(['library_label.list', 'collection.list']);
    const withoutImportAdmission = renderToStaticMarkup(<ShelfSummaryFirstUseLinks locale="en" />);
    expect(withoutImportAdmission).toContain('/en/search');
    expect(withoutImportAdmission).toContain('/en/library/labels');
    expect(withoutImportAdmission).toContain('/en/library/collections');
    expect(withoutImportAdmission).not.toContain('/library/import-');
  } finally {
    setLocale(before, { reload: false });
    admittedOperations = previousAdmission;
    client.clear();
  }
});

test('mounted StrictMode summary reads once, refreshes independently and retires old-account work', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: binding.source });
  const globals = { window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(window.document.createElement('div'));
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library'] }),
  });
  let retired = false;
  let calls = 0;
  let pending = deferred<ShelfSummaryCurrentRead>();
  const read = spyOn(reads, 'readShelfSummaryCurrent').mockImplementation(() => {
    calls++;
    return pending.promise;
  });
  const origin = {
    current: () => !retired,
    capture: () => () => !retired,
    version: () => '1',
  } as unknown as ShelfOrigin;
  let observed!: ReturnType<typeof useShelfSummaryCurrent>;
  function Page() {
    observed = useShelfSummaryCurrent(origin, 'owner', null, 'en', true);
    return <p>{observed.page.state}</p>;
  }
  const render = () =>
    root.render(
      <StrictMode>
        <RouterContextProvider router={router}>
          <Page />
        </RouterContextProvider>
      </StrictMode>,
    );
  try {
    await act(async () => render());
    expect(calls).toBe(1);
    await act(async () => {
      pending.resolve(response(4096));
    });
    expect(observed.page.state).toBe('loaded');
    await act(async () => observed.acknowledge());
    expect(observed.page.state).toBe('stale');
    expect(calls).toBe(1);
    pending = deferred<ShelfSummaryCurrentRead>();
    await act(async () => {
      void observed.retry();
    });
    expect(calls).toBe(2);
    retired = true;
    await act(async () => {
      pending.resolve(response(9999));
      render();
    });
    expect(observed.page.state).toBe('denied');
  } finally {
    await act(async () => root.unmount());
    read.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
