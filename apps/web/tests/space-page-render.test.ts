import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import type { RealmHome } from '../src/community/space';
import { subjectHref } from '../src/subject/subject-href';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import publicationsRecording from '../src/kernel/recorded/realm-publications.json';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const session = await import('../src/session/query');
mock.module('../src/session/query', () => ({
  ...session,
  useSession: () => ({ state: 'signed-in', csrfToken: 'member-csrf', subject: 'story-viewer' }),
}));

const { SpacePage } = await import('../src/community/space-page');
const { loadSpacePage, loadRealmMembership } = await import('../src/community/space');
const { readSetup } = await import('../src/community/space-setup');
const { realmMembershipQuery } = await import('../src/community/realm-membership-queries');
const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
const { m } = await import('../src/paraglide/messages.js');

function client() {
  return createKernelClient('http://kernel.local', { fetch: createStoryRecordedKernelFetch() });
}
const request = new Request('https://site.example.test/en/spaces/atlas-member');

test('the genuine member Space home renders boards, publications and current controls with optional authority unavailable', async () => {
  const kernel = client();
  // This traverses the real recorded-fake discovery, including helper modules without HTTP routes.
  const page = await loadSpacePage(kernel, request, {}, { address: 'atlas-member' }, 'anonymous');
  if (!page.realm) throw new Error('The recorded member Space lost its Realm');
  const viewer = await loadRealmMembership(kernel, page.realm.id, { headers: { authorization: 'Bearer member' } });
  expect(viewer.state).toBe('member');
  expect(await readSetup(kernel, 'Bearer member', page.space.id)).toMatchObject({ kind: 'failure' });

  const queries = new QueryClient();
  queries.setQueryData(realmMembershipQuery(page.realm.id, 'story-viewer').queryKey, viewer);
  const root = createRootRoute({ component: () => createElement(SpacePage, { page }) });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  try {
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queries }, createElement(RouterProvider, { router })),
    );
    expect(html).toContain(page.space.title);
    for (const board of page.realm.boards) expect(html).toContain(board.title ?? m.threads_untitled());
    expect(html).toContain('data-member-state="member"');
    expect(html).toContain(m.realm_leave());
    expect(html).toContain(m.realm_publication_curate());
    expect(html).toContain(m.realm_published_heading());
    expect(html).not.toContain(m.error_heading());
    expect(html).not.toContain(m.realm_boards_empty());
  } finally {
    queries.clear();
  }
});

test('required board unavailability remains a failed Space load rather than an empty or cached home', async () => {
  await expect(
    loadSpacePage(client(), request, {}, { address: 'atlas-boards-unavailable' }, 'anonymous'),
  ).rejects.toThrow('Kernel community read failed');
});

async function renderShelf(realm: RealmHome) {
  const { RealmShelf } = await import('../src/community/space-page');
  const transport = {
    boards: mock(async () => ({ kind: 'denied' as const })),
    publications: mock(async () => ({ kind: 'denied' as const })),
    change: mock(async () => ({ kind: 'denied' as const })),
  };
  const queries = new QueryClient();
  const root = createRootRoute({ component: () => createElement(RealmShelf, { realm, transport, frozen: true }) });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  try {
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queries }, createElement(RouterProvider, { router })),
    );
    expect(transport.boards).not.toHaveBeenCalled();
    expect(transport.publications).not.toHaveBeenCalled();
    expect(transport.change).not.toHaveBeenCalled();
    return [...html.matchAll(/href="([^"]*\/subjects\/[^"]+)"/g)].map((match) => match[1]!);
  } finally {
    queries.clear();
  }
}

test('initial and continued Realm shelves retain one exact selector on each localized canonical subject link without extra reads', async () => {
  const recorded = createStoryRecordedKernelFetch();
  const calls: URL[] = [];
  const kernel = createKernelClient('http://kernel.local', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const read = new Request(input, init);
        const url = new URL(read.url);
        calls.push(url);
        if (url.pathname.endsWith('/publications')) {
          expect(url.searchParams.get('limit')).toBe('12');
          const cursor = url.searchParams.get('cursor');
          if (cursor) expect(cursor).toBe('signed-publication-window');
          return Response.json({
            items: cursor ? publicationsRecording.items.slice(1) : publicationsRecording.items.slice(0, 1),
            next: cursor ? null : 'signed-publication-window',
          });
        }
        return recorded(read);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const page = await loadSpacePage(kernel, request, {}, { address: 'atlas-member' }, 'anonymous');
  if (!page.realm) throw new Error('The recorded member Space lost its Realm');
  const { loadRealmShelfPage } = await import('../src/community/space');
  const initialReads = calls.length;
  const later = await loadRealmShelfPage(
    kernel,
    request,
    {},
    {
      realmId: page.realm.id,
      list: 'publications',
      cursor: page.realm.publicationNext ?? undefined,
      credentialMode: 'anonymous',
    },
  );
  if (later.kind !== 'page') throw new Error('The continued publication window was unavailable');
  expect(later.items.length).toBe(publicationsRecording.items.length - 1);
  expect(calls.length - initialReads).toBe(1 + later.items.length);
  const readCount = calls.length;
  const originalLocale = getLocale();
  try {
    for (const locale of ['en', 'ja', 'zh-Hant'] as const) {
      setLocale(locale, { reload: false });
      for (const realm of [page.realm, { ...page.realm, published: [...page.realm.published, ...later.items] }]) {
        const links = await renderShelf(realm);
        expect(links).toHaveLength(realm.published.length);
        for (const [index, subject] of realm.published.entries()) {
          const label = subject.labels[locale] ?? subject.label ?? subject.labels.en ?? '';
          const canonical = subjectHref({ id: subject.id, label }, locale).href;
          expect(links[index]).toBe(`${canonical}?realm=${encodeURIComponent(realm.id)}`);
          expect([...new URL(links[index]!, request.url).searchParams]).toEqual([['realm', realm.id]]);
          // Ordinary subject navigation continues to use the shared canonical identity without selection.
          expect(new URL(canonical, request.url).search).toBe('');
        }
      }
    }
    // Encoding is local string work even for reserved bytes; it never admits a selector to the native reader.
    const encodedRealm = { ...page.realm, id: 'Realm / +?&=#心' };
    const [encoded] = await renderShelf(encodedRealm);
    expect(encoded?.split('?')[1]).toBe(`realm=${encodeURIComponent(encodedRealm.id)}`);
    expect(new URL(encoded!, request.url).searchParams.get('realm')).toBe(encodedRealm.id);
    expect(calls).toHaveLength(readCount);
  } finally {
    setLocale(originalLocale, { reload: false });
  }
});
