import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { AccountPosts } = await import('../src/features/pages/account');
const { OverviewContext } = await import('../src/features/pages/overview');
const {
  observeContributionActionsRows,
  observeContributionActionsSession,
  sameContributionActionsEpisode,
  ContributionActionsPageScope,
  type ContributionActionsEpisode,
} = await import('../src/accounts/public-profile/contribution-actions/host');
const { sessionQuery } = await import('../src/session/query');
const { unavailableAuthorContributionActionsWire } = await import(
  '../src/accounts/public-profile/contribution-actions/receiver'
);

const id = '00000000-0000-4000-8000-000000000001';

function episode(client: QueryClient, row: Record<string, unknown>): ContributionActionsEpisode {
  return {
    client,
    accountId: id,
    view: 'posts',
    cursor: 'signed+/=cursor',
    locale: 'en',
    page: {},
    read: {},
    source: {},
    selection: { proof: 'native-proof', references: [] },
    publication: {},
    postsPublished: true,
    reviewsPublished: true,
    sessionRevision: 3,
    session: { status: 'success', state: 'signed-in', subject: id, csrfToken: 'csrf-a' },
    navigationRevision: 2,
    wire: unavailableAuthorContributionActionsWire,
    rows: observeContributionActionsRows([row]),
  };
}

test('the one page host retires on page, read, source, author, credential and immediate row-context replacement', () => {
  const client = new QueryClient();
  const parent = {};
  const row = { id: 'rendered-row-only', threadId: id, parentContext: parent };
  const current = episode(client, row);
  expect(sameContributionActionsEpisode(current, episode(client, row))).toBe(true);
  for (const replacement of [
    { page: {} },
    { read: {} },
    { source: {} },
    { selection: { proof: 'same-value-new-source', references: [] } },
    { publication: {} },
    { cursor: 'replacement-cursor' },
    { locale: 'zh-Hant' },
    { sessionRevision: 4 },
    { session: { ...current.session, csrfToken: 'csrf-b' } },
    { navigationRevision: 3 },
    { rows: observeContributionActionsRows([{ ...row, parentContext: {} }]) },
  ]) {
    expect(sameContributionActionsEpisode(current, { ...current, ...replacement })).toBe(false);
  }
});

test('successful session replacement is observed even when the account and credential echo', () => {
  const client = new QueryClient();
  const observation = observeContributionActionsSession(client);
  let notices = 0;
  const unsubscribe = observation.subscribe(() => notices++);
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: id, csrfToken: 'csrf' });
  const first = observation.snapshot();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: id, csrfToken: 'csrf' });
  expect(observation.snapshot()).toBe(first + 1);
  expect(notices).toBeGreaterThan(0);
  unsubscribe();
  client.clear();
});

test('an admitted posts page mounts one bounded host and never derives a selection from its rendered rows', async () => {
  const client = new QueryClient();
  const page = { account: { id, handle: 'reader' } } as never;
  const profile = {
    id,
    kind: 'actor',
    handle: 'reader',
    displayName: null,
    bio: null,
    links: [],
    avatar: null,
    subject: null,
    verified: false,
    automated: false,
    operatorId: null,
    publicViews: { posts: true, reviews: true, collections: true, realms: false },
  };
  const value = {
    locale: 'en',
    account: { id, handle: 'reader' },
    profile,
    sections: new Map([
      [
        'posts',
        {
          ok: true,
          read: { kind: 'accountPosts', id, limit: 20 },
          body: {
            posts: [
              {
                id: '00000000-0000-4000-8000-000000000099',
                kind: 'reply',
                threadId: id,
                thread: { id, title: 'Original public thread' },
                authorId: 'another-author',
                parentId: null,
              },
            ],
            next: 'native-next-cursor',
          },
        },
      ],
    ]),
  } as never;
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <OverviewContext.Provider value={value}>
          <ContributionActionsPageScope page={page} cursor="original+/=cursor" view="posts">
            <AccountPosts id="posts" paged limit={20} />
          </ContributionActionsPageScope>
        </OverviewContext.Provider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToString(<RouterProvider router={router} />);
  expect((html.match(/data-slot="contribution-actions-host"/g) ?? []).length).toBe(1);
  expect(html).toContain('data-action-state="unavailable"');
  expect(html).toContain('data-slot="account-posts-items"');
  expect(html).toContain('Original public thread');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('native-proof');
  client.clear();
});
