import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { loadShellCommunities, SHELL_COMMUNITY_LIMIT } from '../src/shell/community-navigation';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { TopBar, ShellTopActions } = await import('../src/shell/top-bar');
const { SideNav } = await import('../src/shell/side-nav');
const { PhoneNavigationView, PhoneCreationLinks } = await import('../src/shell/phone-navigation');
const { NavigationLinks, NavigationProvider } = await import('../src/shell/navigation-view');
const exposure = await import('../src/kernel/exposure');
afterAll(() => mock.restore());
const html = (content: React.ReactNode) =>
  renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{content}</QueryClientProvider>);

test('the top bar keeps search and logo, offers Create and counted notifications, and replaces account controls with sign-in', () => {
  const render = (session: 'signed-in' | 'signed-out') =>
    html(
      <TopBar
        navigation={<button>Navigation</button>}
        logo={<a href="/en">REZICS</a>}
        search={<input aria-label="Search" />}
        actions={
          <ShellTopActions
            session={session}
            pathname="/inbox"
            returnTo="/en/inbox?q=a"
            account={<button>Account controls</button>}
            unread={{
              signedIn: true,
              state: 'ready',
              count: 123,
              capped: false,
              basis: 'current-visible-unread',
              witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
            }}
          />
        }
      />,
    );

  const member = render('signed-in');
  expect(member.match(/<header/g)).toHaveLength(1);
  for (const text of ['REZICS', 'Search', 'Create', 'Notifications', '99+ unread notifications', 'Account controls'])
    expect(member).toContain(text);
  expect(member).toContain('href="/en/inbox" aria-current="page"');
  const visitor = render('signed-out');
  expect(visitor).toContain('/auth/sign-in?return_to=%2Fen%2Finbox%3Fq%3Da');
  expect(visitor).not.toContain('Account controls');
  expect(visitor).not.toContain('99+ unread notifications');
  expect(
    html(
      <ShellTopActions
        session="signed-in"
        pathname="/"
        returnTo="/en"
        account={null}
        unread={{
          signedIn: true,
          state: 'ready',
          count: 0,
          capped: false,
          basis: 'current-visible-unread',
          witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
        }}
      />,
    ),
  ).not.toContain('unread notifications');
});

test('the default shell rail renders outside the Library boundary with one page landmark and phone destinations', async () => {
  mock.module('@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url', () => ({
    default: '/manrope.woff2',
  }));
  const { AppShell } = await import('../src/shell/app-shell');
  const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import('@tanstack/react-router');
  const session = await import('../src/session/query');
  const member = spyOn(session, 'useSession').mockReturnValue({
    state: 'signed-in',
    subject: 'viewer',
    csrfToken: 'csrf',
  });
  const root = createRootRoute({
    component: () => (
      <AppShell search={<input aria-label="Existing header search" />}>
        <h1>Page content</h1>
      </AppShell>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  try {
    await router.load();
    const markup = html(<RouterProvider router={router} />);
    expect(markup.match(/<main\b/g)).toHaveLength(1);
    expect(markup.match(/<header\b/g)).toHaveLength(1);
    for (const text of ['Page content', 'Existing header search', 'REZICS', 'Main navigation', 'Phone navigation'])
      expect(markup).toContain(text);
  } finally {
    member.mockRestore();
  }
});

test('main and phone navigation mark the current page, and followed communities keep icons and locale-safe destinations', () => {
  const hydration = spyOn(React, 'useSyncExternalStore').mockImplementation((_, client) => client());
  const operation = spyOn(exposure, 'useOperation').mockReturnValue(true);
  try {
    const rail = html(
      <NavigationProvider>
        <NavigationLinks
          context={{ locale: 'en', pathname: '/library/collections' }}
          session="signed-in"
          desktop
          label="Main navigation"
        />
      </NavigationProvider>,
    );
    for (const label of ['Home', 'Library', 'Collections']) expect(rail).toContain(label);
    expect(rail).toContain('href="/en/library/collections" aria-current="page"');
    const visitor = html(
      <NavigationProvider>
        <NavigationLinks context={{ locale: 'en', pathname: '/' }} session="signed-out" label="Main navigation" />
      </NavigationProvider>,
    );
    expect(visitor).toContain('aria-disabled="true"');
    for (const label of ['Library', 'Collections']) expect(visitor).toContain(label);
    const communities = html(
      <SideNav
        pathname="/en/realms/reading/claims"
        items={[
          {
            id: 'r',
            kind: 'realm',
            title: 'Reading together',
            path: '/spaces/reading',
            alternatePath: '/realms/reading',
          },
          { id: 's', kind: 'space', title: 'Quiet space', path: '/spaces/quiet' },
        ]}
      />,
    );
    expect(communities).toContain('href="/en/spaces/reading" title="Reading together" aria-current="page"');
    expect(communities.match(/<a\b[^>]*title="[^"]*"[^>]*><svg\b/g)).toHaveLength(2);
    expect(communities).toContain('Quiet space');
    const phone = html(
      <PhoneNavigationView
        pathname="/library"
        library
        session="signed-in"
        actions={[]}
        account={<button>You</button>}
      />,
    );
    expect(phone).toContain('aria-label="Phone navigation"');
    expect(phone).toContain('href="/en/library" aria-current="page"');
  } finally {
    hydration.mockRestore();
    operation.mockRestore();
  }
});

test('the phone You fallback is a settings link, not serialized markup', () => {
  const phone = html(
    <PhoneNavigationView pathname="/library" library session="signed-in" actions={[]} account={<button>You</button>} />,
  );
  expect(phone).toMatch(/<a[^>]*href="\/en\/settings"[^>]*>You<\/a>/);
  expect(phone).not.toMatch(/contents">[^<]*href="\/en\/settings"/);
});

test('Create gives the same session feedback on phone and desktop and preserves the admitted localized return', () => {
  const destination = '/en/books?q=The%20Prince&cursor=next%2Fpage';
  const signIn = `/auth/sign-in?return_to=${encodeURIComponent(destination)}`;
  const actions = [{ id: 'studio', label: 'Continue writing in Studio', href: '/en/studio' }];
  for (const session of ['unknown', 'signed-out', 'unavailable', 'signed-in'] as const) {
    const panel = html(
      <PhoneCreationLinks actions={actions} pathname="/en/books" session={session} returnTo={destination} />,
    );
    if (session === 'signed-in') expect(panel).toContain('href="/en/studio"');
    else expect(panel).not.toContain('href="/en/studio"');
    if (session === 'unknown') {
      expect(panel).toContain('role="status" aria-busy="true"');
      expect(panel).not.toContain('/auth/sign-in');
    } else if (session !== 'signed-in') expect(panel).toContain(`href="${signIn}"`);
    if (session === 'unavailable') expect(panel).toContain('Account status unavailable');
    const phone = html(
      <PhoneNavigationView
        pathname="/en/books"
        session={session}
        returnTo={destination}
        library
        actions={actions}
        account={null}
      />,
    );
    if (session === 'signed-out') expect(phone).toContain(`href="${signIn}"`);
    if (session === 'unknown' || session === 'unavailable')
      expect(phone).toMatch(/data-phone-inbox-js[^>]*aria-disabled="true"/);
  }
  const home = html(
    <PhoneNavigationView pathname="/en" session="signed-out" library={false} actions={[]} account={null} />,
  );
  expect(home).toContain('href="/en" aria-current="page"');
  expect(home).toContain('/auth/sign-in?return_to=%2Fen');
});

test('only readable active followed Spaces become navigation, grouped as Realms when readable, with bounded enrichment', async () => {
  const reads: string[] = [];
  const client = {
    follows: {
      get: async () => ({
        data: {
          follows: [
            { targetId: 'removed', targetType: 'space', state: 'unfollowed', target: {} },
            { targetId: 'hidden', targetType: 'space', state: 'following', target: null },
            ...Array.from({ length: 20 }, (_, index) => ({
              targetId: String(index),
              targetType: 'space',
              state: 'following',
              target: {},
            })),
          ],
          next: 'next',
        },
      }),
    },
    spaces: ({ spaceId }: { spaceId: string }) => ({
      get: async () => {
        reads.push(spaceId);
        return {
          data: {
            space: {
              spaceId,
              state: spaceId === '2' ? 'taken_down' : 'active',
              title: `Space ${spaceId}`,
              address: `space ${spaceId}`,
              realmId: spaceId === '0' ? 'realm' : null,
            },
          },
        };
      },
    }),
    realms: () => ({
      get: async () => ({ data: { realm: { realmId: 'realm', spaceId: '0', state: 'active', title: 'A Realm' } } }),
    }),
  } as unknown as KernelClient;
  const result = await loadShellCommunities(client, 'Bearer viewer');
  expect(reads).toHaveLength(SHELL_COMMUNITY_LIMIT);
  expect(reads).not.toContain('hidden');
  expect(result.items[0]).toEqual({
    id: '0',
    kind: 'realm',
    title: 'A Realm',
    path: '/spaces/space%200',
    alternatePath: '/realms/realm',
  });
  expect(result.items.some((item) => item.id === '2')).toBe(false);
  expect(result.items[1]?.kind).toBe('space');
  expect(result.more).toBe(true);
});
