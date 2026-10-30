import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
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
  queries.setQueryData(realmMembershipQuery(page.realm.id).queryKey, viewer);
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
