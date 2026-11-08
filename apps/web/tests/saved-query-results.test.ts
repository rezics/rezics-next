import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import {
  isOrdinarySavedQuery,
  RuleEditLink,
  savedQueryResultsAddress,
  savedQueryRuleReturn,
} from '../src/library/saved-query-results.tsx';
import {
  admitSavedQueryResultsWindow,
  cancelSavedQueryResultsWindowFocus,
  failSavedQueryResultsWindowMove,
  hasPendingSavedQueryResultsWindowTarget,
  readSavedQueryResultsWindow,
  retireSavedQueryResultsWindows,
  savedQueryResultsWindowBase,
  stageSavedQueryResultsWindowMove,
} from '../src/library/saved-query-results-windows';
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
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { getLocale } = await import('../src/paraglide/runtime.js');

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const savedPage = {
  id: 'saved',
  title: 'Saved query',
  description: null,
  curator: null,
  curatorAccountId: 'owner',
  membershipKind: 'dynamic' as const,
  visibility: 'public' as const,
  revision: 1,
  // The authenticated owner's detail read carries this admitted action beside the page.
  viewerActions: {
    state: 'ready' as const,
    actions: [{ action: 'collection:update', operations: ['collection_rule.update'] }],
  },
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
  // The signed-in viewer's admitted groups are read under the session observation, as the browser does.
  // The observation exists only while the lifetime is connected, so connect it for this synchronous render.
  const stop = viewerExposureLifetime(queries).subscribe(() => {});
  try {
    const exposure = viewerExposureLifetime(queries).getSnapshot();
    if (viewerId && exposure.state === 'signed-in')
      queries.setQueryData(viewerExposureQuery(exposure.observation).queryKey, {
        subject: viewerId,
        admitted: ['collections'],
      });
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
  } finally {
    stop();
  }
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
  expect(
    renderToStaticMarkup(createElement(RuleEditLink, { collection: saved, viewerId: 'owner', allowed: true })),
  ).toContain('/collections/saved/rule');
  expect(
    renderToStaticMarkup(createElement(RuleEditLink, { collection: saved, viewerId: 'reader', allowed: true })),
  ).toBe('');
  expect(
    renderToStaticMarkup(
      createElement(RuleEditLink, { collection: { ...saved, builtinKind: 'liked' }, viewerId: 'owner', allowed: true }),
    ),
  ).toBe('');
});

test('rule returns retain the directory origin and reset only the result cursor after save', () => {
  const collection = { id: 'saved/query', curatorAccountId: 'owner', membershipKind: 'dynamic' as const };
  const directoryHref = '/en/library/collections?cursor=directory%2B%2F%3D%3D&layout=previews';
  const resultsHref = savedQueryResultsAddress(
    'en',
    collection.id,
    'results+/==',
    {},
    {
      layout: 'list',
      returnTo: directoryHref,
    },
  );
  const html = renderToStaticMarkup(
    createElement(RuleEditLink, { collection, viewerId: 'owner', allowed: true, resultsHref }),
  );
  const editHref = [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => match[1])
    .find((href) => href.includes('/rule?returnTo='));
  expect(editHref).toBeDefined();
  const resultAddress = new URL(editHref!, 'https://rezics.invalid').searchParams.get('returnTo');
  expect(resultAddress).toBe(savedQueryRuleReturn(resultsHref, collection.id, 'en'));

  const afterSave = new URL(savedQueryRuleReturn(resultAddress!, collection.id, 'en', true), 'https://rezics.invalid');
  expect(afterSave.searchParams.get('cursor')).toBeNull();
  expect(afterSave.searchParams.get('layout')).toBe('list');
  expect(afterSave.searchParams.get('returnTo')).toBe(directoryHref);
  expect(savedQueryRuleReturn('/en/collections/other?cursor=unsafe', collection.id, 'en')).toBe(
    savedQueryResultsAddress('en', collection.id, undefined),
  );
});

test('default results and rule routes preserve the full admitted directory return through correction and deletion', async () => {
  const { Route: results } = await import('../src/routes/collections/$id');
  const { Route: rule } = await import('../src/routes/collections/$id_.rule');
  const { savedQueryReturnTo } = await import('../src/library/saved-query-management/return-to');
  const validate = (route: typeof results | typeof rule, returnTo: string) =>
    (route.options.validateSearch as (input: Record<string, unknown>) => { returnTo?: string })({ returnTo }).returnTo;
  for (const cursor of ['x'.repeat(4096), '%+'.repeat(2048), '\u0800'.repeat(4096)]) {
    const directory = `/en/library/collections?${new URLSearchParams({ cursor, layout: 'previews' })}`;
    const admitted = validate(results, directory);
    expect(admitted).toBe(directory);
    const href = savedQueryResultsAddress(
      'en',
      'saved',
      cursor,
      { type: 'schema:Book' },
      {
        layout: 'list',
        returnTo: admitted,
      },
    );
    expect(validate(rule, href)).toBe(href);
    expect(savedQueryRuleReturn(href, 'saved', 'en')).toBe(href);
    const corrected = new URL(savedQueryRuleReturn(href, 'saved', 'en', true), 'https://site.test');
    expect(corrected.searchParams.has('cursor')).toBe(false);
    expect(corrected.searchParams.get('type')).toBe('schema:Book');
    expect(corrected.searchParams.get('layout')).toBe('list');
    expect(savedQueryReturnTo(corrected.searchParams.get('returnTo')!, 'en')).toBe(directory);
  }
  for (const address of [
    'https://elsewhere.test/en/library/collections',
    '/ja/library/collections',
    `/en/library/collections?cursor=${'x'.repeat(4097)}`,
  ])
    expect(validate(results, address)).toBe('/en/library/collections');
});

test('saved result coordinates traverse, revisit, reset and abandon the old forward branch', () => {
  const queries = new QueryClient();
  const base = savedQueryResultsWindowBase({
    id: 'saved',
    search: { type: 'schema:Book', 'r.schema:wordCount': ['0,10', '2,20'] },
    locale: 'en',
    admission: 1,
  });
  const scope = 'session/owner/revision-1/release-a';
  const admit = (cursor: string | undefined, restarted = false) =>
    admitSavedQueryResultsWindow(queries, base, 'session', scope, cursor, restarted);
  const move = (from: string | undefined, target: string | undefined, movement: 'continue' | 'previous' | 'first') => {
    expect(stageSavedQueryResultsWindowMove(queries, base, 'session', scope, from, target, movement)).toBe(true);
    expect(admit(target).changed).toBe(true);
  };

  expect(readSavedQueryResultsWindow(queries, base, 'session', scope, undefined).hasPrevious).toBe(false);
  expect(admit(undefined).changed).toBe(true);
  move(undefined, 'opaque/+==/二', 'continue');
  move('opaque/+==/二', 'third-cursor', 'continue');
  move('third-cursor', 'terminal-empty', 'continue');
  let current = readSavedQueryResultsWindow(queries, base, 'session', scope, 'terminal-empty');
  expect(current.hasPrevious).toBe(true);
  expect(current.previous).toBe('third-cursor');

  move('terminal-empty', 'third-cursor', 'previous');
  current = readSavedQueryResultsWindow(queries, base, 'session', scope, 'third-cursor');
  expect(current.previous).toBe('opaque/+==/二');
  move('third-cursor', 'new-forward-branch', 'continue');
  current = readSavedQueryResultsWindow(queries, base, 'session', scope, 'new-forward-branch');
  expect(current.previous).toBe('third-cursor');
  move('new-forward-branch', undefined, 'first');
  expect(readSavedQueryResultsWindow(queries, base, 'session', scope, undefined).hasPrevious).toBe(false);

  let cursor: string | undefined;
  admit(undefined);
  for (let index = 1; index <= 10; index++) {
    const next = `bounded-${index}`;
    move(cursor, next, 'continue');
    cursor = next;
  }
  expect(readSavedQueryResultsWindow(queries, base, 'session', scope, cursor).previous).toBe('bounded-9');
  for (let index = 0; index < 8; index++) {
    const state = readSavedQueryResultsWindow(queries, base, 'session', scope, cursor);
    expect(state.hasPrevious).toBe(true);
    const previous = state.previous;
    move(cursor, previous, 'previous');
    cursor = previous;
  }
  expect(readSavedQueryResultsWindow(queries, base, 'session', scope, cursor).hasPrevious).toBe(false);

  queries.clear();
});

test('failed exact targets stay staged, public reads cannot commit private moves, and scope changes retire paths', () => {
  const queries = new QueryClient();
  const base = savedQueryResultsWindowBase({ id: 'saved', locale: 'en', admission: 2 });
  const sessionScope = 'session/owner/revision-2/release-b';
  const publicScope = 'anonymous/public/revision-2/release-b';
  admitSavedQueryResultsWindow(queries, base, 'session', sessionScope, undefined, false);
  expect(stageSavedQueryResultsWindowMove(queries, base, 'session', sessionScope, undefined, 'first', 'continue')).toBe(
    true,
  );
  admitSavedQueryResultsWindow(queries, base, 'session', sessionScope, 'first', false);
  expect(stageSavedQueryResultsWindowMove(queries, base, 'session', sessionScope, 'first', 'second', 'continue')).toBe(
    true,
  );
  admitSavedQueryResultsWindow(queries, base, 'session', sessionScope, 'second', false);
  expect(
    stageSavedQueryResultsWindowMove(queries, base, 'session', sessionScope, 'second', 'failed/+==', 'continue'),
  ).toBe(true);
  expect(failSavedQueryResultsWindowMove(queries, base, 'session', sessionScope, 'failed/+==')).toBe(true);
  expect(hasPendingSavedQueryResultsWindowTarget(queries, base, 'session', 'failed/+==')).toBe(true);

  admitSavedQueryResultsWindow(queries, base, 'anonymous', publicScope, 'failed/+==', false);
  expect(readSavedQueryResultsWindow(queries, base, 'session', sessionScope, 'failed/+==')).toMatchObject({
    pendingTarget: true,
    failedTarget: true,
    hasPrevious: false,
  });
  expect(admitSavedQueryResultsWindow(queries, base, 'session', sessionScope, 'failed/+==', false).changed).toBe(true);
  expect(readSavedQueryResultsWindow(queries, base, 'session', sessionScope, 'failed/+==')).toMatchObject({
    previous: 'second',
    hasPrevious: true,
    failedTarget: false,
  });
  expect(
    stageSavedQueryResultsWindowMove(queries, base, 'session', sessionScope, 'failed/+==', 'second', 'previous'),
  ).toBe(true);
  admitSavedQueryResultsWindow(queries, base, 'session', sessionScope, 'second', false);
  expect(readSavedQueryResultsWindow(queries, base, 'session', sessionScope, 'second').previous).toBe('first');

  const changedScope = 'session/owner/revision-3/release-c';
  admitSavedQueryResultsWindow(queries, base, 'session', changedScope, 'direct-later-cursor', false);
  expect(readSavedQueryResultsWindow(queries, base, 'session', changedScope, 'direct-later-cursor').hasPrevious).toBe(
    false,
  );
  expect(admitSavedQueryResultsWindow(queries, base, 'session', changedScope, 'expired-cursor', true).changed).toBe(
    true,
  );
  expect(readSavedQueryResultsWindow(queries, base, 'session', changedScope, undefined).hasPrevious).toBe(false);

  const otherBase = savedQueryResultsWindowBase({ id: 'other', locale: 'en', admission: 2 });
  admitSavedQueryResultsWindow(queries, otherBase, 'session', 'other', 'unrelated', false);
  expect(readSavedQueryResultsWindow(queries, base, 'session', changedScope, undefined).hasPrevious).toBe(false);
  retireSavedQueryResultsWindows(queries);
  expect(readSavedQueryResultsWindow(queries, base, 'session', changedScope, undefined).hasPrevious).toBe(false);
  queries.clear();
});

test('a saved results page keeps unique subjects, omits counts, notes and the built-in rule copy', () => {
  const html = renderPage(savedPage, 'owner');
  const text = html.replace(/<[^>]*>/g, ' ');
  expect(html).toContain('Saved query');
  expect(html).toContain('A book');
  expect(html).toContain('/collections/saved/rule');
  expect(html).toContain('/collections/saved/publish');
  expect(html).not.toContain(m.library_collection_builtin_rule());
  expect(html).not.toContain('owner:{');
  expect(text).not.toMatch(/\bUpdated\b/);
  expect(text).not.toMatch(/\b\d+ items?\b/);
  expect(text).not.toMatch(/\bAdd\b/);
  expect(text).not.toMatch(/\bNote\b/);
  expect(renderPage(savedPage, 'reader')).not.toContain('/collections/saved/rule');
  expect(renderPage(savedPage, 'reader')).not.toContain('/collections/saved/publish');
  expect(renderPage({ ...savedPage, builtinKind: 'everything' })).toContain(m.library_collection_builtin_rule());
  expect(renderPage({ ...savedPage, builtinKind: 'everything' }, 'owner')).not.toContain('/publish');
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

test('first result window can cancel focus without a staged movement', () => {
  const queries = new QueryClient();
  admitSavedQueryResultsWindow(queries, 'base', 'session', 'scope', undefined, false);
  expect(cancelSavedQueryResultsWindowFocus(queries, 'base', 'session', 'scope', undefined)).toBe(false);
});
