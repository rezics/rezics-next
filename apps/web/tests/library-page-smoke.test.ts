import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { PersonalLibraryPage } = await import('../src/library/entries-page');

const labels = [
  ['en', 'Labels'],
  ['zh-Hant', '標籤'],
  ['zh-Hans', '标签'],
  ['ja', 'ラベル'],
  ['ko', '라벨'],
  ['de', 'Schlagwörter'],
  ['fr', 'Étiquettes'],
  ['es', 'Etiquetas'],
] as const;

test('the Personal Library navigation renders with its real localized labels message in every supported locale', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const route = createRootRoute({
    component: () =>
      createElement(PersonalLibraryPage, {
        page: { signedIn: true, state: 'in_progress', entries: [], next: null },
        locale: 'en',
        display: { layout: 'grid', size: 'm' },
      }),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/library'] }) });
  await router.load();
  const markup = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
  );

  expect(markup).toContain('<h1');
  expect(markup).toContain('Library');
  for (const [locale, expected] of labels) {
    expect(m.library_nav_labels({}, { locale })).toBe(expected);
  }
});
