import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
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
          placement="global-sidebar"
          label="Main navigation"
        />
      </NavigationProvider>,
    );
    for (const label of ['Home', 'Books', 'Search', 'Library']) expect(rail).toContain(label);
    for (const label of ['Collections', 'Orders', 'Drafts', 'Inbox']) expect(rail).not.toContain(label);
    expect(rail).toContain('href="/en/library" aria-current="page"');
    const tools = html(
      <NavigationLinks
        context={{ locale: 'en', pathname: '/settings' }}
        session="signed-in"
        placement="account-tools"
        label="Account tools"
      />,
    );
    for (const destination of ['/library/collections', '/orders', '/drafts', '/studio', '/moderation/workbench'])
      expect(tools).toContain(`href="/en${destination}"`);
    expect(tools).not.toContain('href="/en/inbox"');
    const visitor = html(
      <NavigationProvider>
        <NavigationLinks
          context={{ locale: 'en', pathname: '/' }}
          session="signed-out"
          placement="global-sidebar"
          label="Main navigation"
        />
      </NavigationProvider>,
    );
    for (const label of ['Library', 'Collections']) expect(visitor).not.toContain(label);
    const communities = html(
      <SideNav
        pathname="/en/realms/reading/claims"
        items={[
          {
            id: 'r',
            kind: 'realm',
            title: 'Reading together',
            path: '/realms/reading',
          },
          { id: 's', kind: 'space', title: 'Quiet space', path: '/spaces/quiet' },
        ]}
      />,
    );
    expect(communities).toContain('href="/en/realms/reading" title="Reading together" aria-current="page"');
    expect(communities.match(/<a\b[^>]*title="[^"]*"[^>]*><svg\b/g)).toHaveLength(3);
    expect(communities).toContain('Quiet space');
    expect(communities.match(/<h2\b/g)).toHaveLength(1);
    expect(communities.match(/href="\/en\/library\/following"/g)).toHaveLength(1);
    expect(communities).toContain('focus-visible:ring-ring');
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

test('a native Space-filtered FULL page supplies canonical navigation without point reads', async () => {
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      paths.push(url.pathname);
      expect(url.pathname).toBe('/v1/follows');
      expect(url.searchParams.get('targetType')).toBe('space');
      expect(url.searchParams.get('view')).toBe('FULL');
      expect(url.searchParams.get('limit')).toBe(String(SHELL_COMMUNITY_LIMIT));
      expect(request.headers.get('authorization')).toBe('Bearer viewer');
      expect(request.cache).toBe('no-store');
      const row = (targetId: string, label: unknown, destination: unknown, state = 'following') => ({
        targetId,
        targetType: 'space',
        state,
        reason: 'explicit',
        target: label === null ? null : { id: targetId, type: 'space', label },
        destination,
      });
      // The server returns this Space window even when hundreds of Subject follows precede it.
      return Response.json({
        follows: [
          row('realm-space', { value: '読書会', language: 'ja' }, { kind: 'realm', realmId: 'native-realm' }),
          row('ordinary', 'Quiet space', { kind: 'space', spaceId: 'ordinary', address: 'quiet room' }),
          row('hidden', null, { kind: 'unavailable' }),
          row('withheld', 'Withheld destination', { kind: 'unavailable' }),
          row('missing-destination', 'No address', undefined),
          row('removed', 'Removed', { kind: 'space', spaceId: 'removed', address: 'gone' }, 'unfollowed'),
        ],
        next: 'next-spaces',
      });
    },
  });
  const result = await loadShellCommunities(client, 'Bearer viewer');
  expect(paths).toEqual(['/v1/follows']);
  expect(result).toEqual({
    items: [
      { id: 'realm-space', kind: 'realm', title: '読書会', titleLanguage: 'ja', path: '/realms/native-realm' },
      { id: 'ordinary', kind: 'space', title: 'Quiet space', titleLanguage: undefined, path: '/spaces/quiet%20room' },
    ],
    more: true,
  });
});

test('a failed native Follow read remains unavailable instead of looking like an empty sidebar', async () => {
  const client = createKernelClient('https://kernel.test', {
    fetch: async () => Response.json({ code: 'unavailable' }, { status: 503 }),
  });
  await expect(loadShellCommunities(client, 'Bearer viewer')).rejects.toThrow('Community navigation unavailable');
});
