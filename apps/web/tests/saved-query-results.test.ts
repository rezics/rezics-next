import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import { isOrdinarySavedQuery, RuleEditLink } from '../src/library/saved-query-results.tsx';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { DynamicCollectionPage } = await import('../src/library/dynamic-collection-page.tsx');
const { loadEditableCollectionPage } = await import('../src/library/collection-load.ts');
const { libraryNavigationQuery } = await import('../src/library/pins-read');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { getLocale } = await import('../src/paraglide/runtime.js');

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const savedPage = {
  id: 'saved',
  title: 'Saved query',
  description: null,
  curator: null,
  curatorAccountId: 'owner',
  members: [{ subject: { id: 'book-1', type: 'book', types: ['book'], label: 'A book', cover: null } }],
  next: null as string | null,
  preparing: false,
  unavailable: false,
  retryAfterMs: 1000,
};

function renderPage(page: typeof savedPage & Record<string, unknown>, viewerId?: string | null) {
  const locale = getLocale();
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, gcTime: Infinity } },
  });
  queries.setQueryData(sessionQuery.queryKey, {
    state: viewerId ? 'signed-in' : 'signed-out',
    csrfToken: viewerId ? 'csrf' : null,
    subject: viewerId ?? null,
  });
  queries.setQueryData(exposureQuery.queryKey, []);
  queries.setQueryData(libraryNavigationQuery(locale, 100).queryKey, { pins: { state: 'closed' }, collections: [] });
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queries },
      createElement(
        RouterContextProvider,
        { router },
        createElement(DynamicCollectionPage, { page, ...(viewerId === undefined ? {} : { viewerId }) }),
      ),
    ),
  );
}

function client(id: string, members: (url: URL) => Response) {
  const paths: string[] = [];
  return {
    paths,
    kernel: withPlatformClosedRecognition(
      createKernelClient('https://kernel.test', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          paths.push(`${url.pathname}${url.search}`);
          if (url.pathname === `/v1/collections/${id}`)
            return Response.json({
              collection: {
                id,
                curatorAccountId: 'owner',
                title: 'Saved query',
                description: null,
                visibility: 'public',
                revision: 1,
                membershipKind: 'dynamic',
              },
            });
          if (url.pathname === `/v1/collections/${id}/members`) return members(url);
          throw new Error(`unexpected ${request.method} ${url.pathname}`);
        }) as typeof fetch,
      }),
    ),
  };
}

test('ordinary saved identities omit builtinKind and never offer a built-in or public rule editor', () => {
  expect(isOrdinarySavedQuery({})).toBe(true);
  expect(isOrdinarySavedQuery({ builtinKind: 'everything' })).toBe(false);
  const saved = { id: 'saved', curatorAccountId: 'owner', membershipKind: 'dynamic' as const };
  expect(renderToStaticMarkup(createElement(RuleEditLink, { collection: saved, viewerId: 'owner', allowed: true }))).toContain(
    '/collections/saved/rule',
  );
  expect(
    renderToStaticMarkup(createElement(RuleEditLink, { collection: saved, viewerId: 'reader', allowed: true })),
  ).toBe('');
  expect(
    renderToStaticMarkup(
      createElement(RuleEditLink, { collection: { ...saved, builtinKind: 'liked' }, viewerId: 'owner', allowed: true }),
    ),
  ).toBe('');
});

test('a saved results page keeps unique subjects, omits counts, notes and the built-in rule copy', () => {
  const html = renderPage(savedPage, 'owner');
  const text = html.replace(/<[^>]*>/g, ' ');
  expect(html).toContain('Saved query');
  expect(html).toContain('A book');
  expect(html).toContain('/collections/saved/rule');
  expect(html).not.toContain(m.library_collection_builtin_rule());
  expect(html).not.toContain('owner:{');
  expect(text).not.toMatch(/\bUpdated\b/);
  expect(text).not.toMatch(/\bitems?\b/);
  expect(text).not.toMatch(/\bAdd\b/);
  expect(text).not.toMatch(/\bNote\b/);
  expect(renderPage(savedPage, 'reader')).not.toContain('/collections/saved/rule');
  expect(renderPage({ ...savedPage, builtinKind: 'everything' })).toContain(m.library_collection_builtin_rule());
});

test('202 preparing, empty 200 and 503 stay distinct; stale cursors restart once on the same Collection', async () => {
  for (const [id, members, expectPage] of [
    [
      'preparing',
      () => Response.json({ preparing: true }, { status: 202, headers: { 'retry-after': '1' } }),
      { preparing: true, unavailable: false, members: [] },
    ],
    ['empty', () => Response.json({ members: [], next: null }), { preparing: false, unavailable: false, members: [] }],
    [
      'unavailable',
      () => Response.json({ code: 'unavailable' }, { status: 503 }),
      { preparing: false, unavailable: true, members: [] },
    ],
  ] as const) {
    const { kernel, paths } = client(id, members);
    const page = await loadEditableCollectionPage(
      kernel,
      new Request('https://site.test/collection'),
      {},
      { id },
      'anonymous',
    );
    expect(page).toMatchObject(expectPage);
    expect(paths.filter((path) => path.includes('/rule'))).toEqual([]);
    expect(paths.filter((path) => path.startsWith(`/v1/collections/${id}?`))).toHaveLength(1);
    expect(paths.filter((path) => path.includes('/members'))).toHaveLength(1);
  }
  const stale = client('stale', (url) =>
    url.searchParams.get('cursor')
      ? Response.json({ code: 'stale_cursor' }, { status: 409 })
      : Response.json({
          members: [{ kind: 'dynamic', subjectId: 's-1', subject: { id: 's-1', type: 'book', label: 'Kept' } }],
          next: null,
        }),
  );
  const page = await loadEditableCollectionPage(
    stale.kernel,
    new Request('https://site.test/collection'),
    {},
    { id: 'stale', cursor: 'expired-cursor' },
    'anonymous',
  );
  expect(page).toMatchObject({ cursorRestarted: true, preparing: false, unavailable: false });
  expect(page.members).toHaveLength(1);
  expect('memberCount' in page).toBe(false);
  expect(stale.paths.filter((path) => path.includes('/members'))).toEqual([
    '/v1/collections/stale/members?view=FULL&limit=100&cursor=expired-cursor',
    '/v1/collections/stale/members?view=FULL&limit=100',
  ]);
});

test('restarted cursors and named stories keep recovery, empty, denied and unavailable distinct', () => {
  const html = renderPage({ ...savedPage, cursor: 'expired', cursorRestarted: true, next: 'more' });
  expect(html).toContain(m.library_collections_cursor_reset());
  expect(html).toContain(m.library_dynamic_page_reader_first_page());
  const story = source('../src/stories/library-saved-query-results.stories.tsx');
  expect([...story.matchAll(/export const (\w+): Story/g)].map((match) => match[1])).toEqual([
    'OwnerReady',
    'Empty',
    'Preparing',
    'Denied',
    'Unavailable',
    'Recovery',
  ]);
  expect(story).toContain('PageStory visitor="Signed In"');
  expect(story).toContain('dynamic-saved-empty');
  expect(story).toContain('dynamic-saved-preparing');
  expect(story).toContain('dynamic-saved-unavailable');
  expect(story).toContain('path="/collections/dynamic-saved-private"');
  expect(story).toContain('path="/collections/dynamic-saved"');
  expect(story).toContain('cursorRestarted: true');
  for (const locale of locales) {
    const messages = JSON.parse(source(`../messages/${locale}.json`)) as Record<string, string>;
    for (const key of [
      'library_rule_edit',
      'library_collections_cursor_reset',
      'library_dynamic_preparing',
      'library_dynamic_unavailable',
      'library_collection_empty',
      'library_dynamic_page_reader_first_page',
    ])
      expect(messages[key]?.trim().length).toBeGreaterThan(0);
  }
});
