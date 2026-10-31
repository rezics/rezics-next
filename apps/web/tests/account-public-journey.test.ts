import { expect, test, mock } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Render-only tests do not invoke Worker bindings. API assertions below use the actual generated client.
mock.module('cloudflare:workers', () => ({ env: {} }));

const { accountOf, viewIsPublic } = await import('../src/features/pages/account-read');
const { loadPublicAccountJourney, pageProfile } = await import('../src/accounts/public-profile/page-read');
const { readPublicRealms } = await import('../src/accounts/public-profile/read');
const { PublicRealmsPage } = await import('../src/accounts/public-profile/view');
const { PublicProfilePage } = await import('../src/accounts/public-profile/page');
const { profilePage } = await import('../src/stories/pages/accounts-public-profile/fixtures');

const accountId = '0192f3a0-6c1e-7b2a-8000-000000000001';
const realmId = '0192f3a0-6c1e-7b2a-8000-000000000002';
const hiddenId = '0192f3a0-6c1e-7b2a-8000-000000000003';
const profile = (extra: Record<string, unknown> = {}) =>
  accountOf({
    accounts: [
      {
        id: accountId,
        kind: 'actor',
        state: 'active',
        handle: 'reader',
        publicViews: { realms: true },
        ...extra,
      },
    ],
  })!;

function clientWith(handler: (request: Request) => Response | Promise<Response>) {
  return createKernelClient('https://kernel.test', {
    fetch: ((input, init) => handler(new Request(input, init))) as typeof fetch,
  });
}

test('public profile only marks a visible verified Subject; pending and deleted accounts have no presentation', () => {
  expect(profile({ verified: true, subject: null }).verified).toBe(false);
  expect(
    profile({ verified: false, subject: { id: realmId, label: 'Pointer only', type: 'schema:Person' } }).verified,
  ).toBe(false);
  expect(
    profile({
      verified: true,
      subject: { id: realmId, label: 'Catalogue person', type: 'schema:Person' },
      verificationRequest: { evidence: 'private' },
    }),
  ).toMatchObject({ verified: true });
  expect(JSON.stringify(profile({ evidence: 'private', email: 'private@example.test' }))).not.toContain('private');
  for (const state of ['pending', 'deleted'])
    expect(accountOf({ accounts: [{ id: accountId, state }] })).toBeUndefined();
  expect(viewIsPublic(profile({ publicViews: {} }), 'realms')).toBe(false);
});

test('Realms consumes the signed owner continuation anonymously, omits hidden rows and never scans for handles', async () => {
  const calls: string[] = [];
  const client = clientWith((request) => {
    expect(request.headers.has('authorization')).toBe(false);
    const url = new URL(request.url);
    calls.push(url.pathname);
    if (url.pathname.endsWith(`/accounts/${accountId}/realms`)) {
      expect(url.searchParams.get('cursor')).toBe('signed+/=cursor');
      expect(url.searchParams.get('limit')).toBe('20');
      return Response.json({
        realms: [
          { id: realmId, role: 'member' },
          { id: hiddenId, role: 'owner' },
        ],
        next: 'next-signed',
      });
    }
    if (url.pathname.endsWith(hiddenId)) return Response.json({ code: 'not_found' }, { status: 404 });
    return Response.json({ realm: { realmId, title: 'Public reading room', summary: null } });
  });
  const result = await readPublicRealms(client, profile(), 'signed+/=cursor');
  expect(result).toEqual({
    state: 'ready',
    realms: [{ id: realmId, role: 'member', title: 'Public reading room', summary: null }],
    next: 'next-signed',
  });
  expect(calls).toEqual([`/v1/accounts/${accountId}/realms`, `/v1/realms/${realmId}`, `/v1/realms/${hiddenId}`]);
  calls.length = 0;
  expect(await readPublicRealms(client, profile({ publicViews: { realms: false } }))).toEqual({ state: 'denied' });
  expect(calls).toEqual([]);
});

test('denied, preparing, invalid continuation and unavailable are distinct from a genuinely empty Realm page', async () => {
  for (const [status, state] of [
    [403, 'denied'],
    [202, 'preparing'],
    [400, 'invalid-cursor'],
    [503, 'unavailable'],
  ] as const) {
    expect(
      await readPublicRealms(
        clientWith(() => Response.json({ code: 'failure' }, { status })),
        profile(),
      ),
    ).toEqual({ state });
  }
  expect(
    await readPublicRealms(
      clientWith(() => Response.json({ realms: [], next: null })),
      profile(),
    ),
  ).toEqual({ state: 'ready', realms: [], next: null });
  const failedHydration = clientWith((request) =>
    new URL(request.url).pathname.endsWith('/realms')
      ? Response.json({ realms: [{ id: realmId, role: 'member' }], next: null })
      : Response.json({ code: 'dependency_unavailable' }, { status: 503 }),
  );
  expect(await readPublicRealms(failedHydration, profile())).toEqual({ state: 'unavailable' });
  const html = renderToString(
    createElement(PublicRealmsPage, {
      handle: 'reader',
      title: 'Reader',
      locale: 'en',
      result: { state: 'ready', realms: [], next: 'signed+/=' },
    }),
  );
  expect(html).toContain('cursor=signed%2B%2F%3D');
  expect(html).not.toContain('No public Realms to show');
});

test('composed public pages keep automation visible when operator hydration is unavailable or has no handle', () => {
  const page = profilePage({ profile: { automated: true, operatorId: accountId } });
  const render = (operator?: { id: string; handle: string | null; displayName: string | null }) => {
    const cache = new QueryClient();
    cache.setQueryData(['exposure', 'anonymous'], []);
    return renderToString(
      createElement(QueryClientProvider, {
        client: cache,
        children: createElement(PublicProfilePage, {
          page,
          locale: 'en',
          messages: {
            unknown: 'Unknown',
            none: 'None',
            unlabelled: 'Account',
            sources: 'Sources',
            aliases: 'Aliases',
            details: 'Details',
          },
          publicRealms: true,
          renderJsonLd: false,
          ...(operator ? { operator } : {}),
        }),
      }),
    );
  };
  expect(render()).toContain('Automated account');
  const html = render({ id: accountId, handle: null, displayName: 'Reading Room' });
  expect(html).toContain('Reading Room');
  expect(html).not.toContain('href="/en/@"');
  expect(html).not.toContain('followers');
});

test('the real generated page client retains source view privacy and canonical forwarding without listing accounts', async () => {
  const page = profilePage({
    profile: { movedTo: 'current-reader', handle: 'current-reader', publicViews: { realms: false } },
  });
  const calls: string[] = [];
  const client = clientWith(async (request) => {
    const url = new URL(request.url);
    calls.push(url.pathname);
    expect(request.headers.has('authorization')).toBe(false);
    const body = (await request.json()) as { target: { account: string; view?: string } };
    expect(body.target).toEqual({ account: 'former-reader' });
    return Response.json({ ...page, account: page.account!.id });
  });
  expect(
    await loadPublicAccountJourney(client, {
      handle: 'former-reader',
      locale: 'en',
      view: 'realms',
      search: '?cursor=signed',
    }),
  ).toEqual({ kind: 'redirect', redirectTo: '/en/@current-reader/realms?cursor=signed' });
  expect(calls).toEqual(['/v1/pages:read']);
  expect(pageProfile(page)?.publicViews.realms).toBe(false);
});

test('Default public identity and management presentation keeps long phone identities readable, management links distinct and connected managed detail stories within their real session/query providers', async () => {
  const { AccountManagementPage } = await import('../src/accounts/management/pages');
  const { detailExample, human } = await import('../src/accounts/management/story-api');
  const displayName = '閱讀者與翻譯者共同維護的獨立閱讀室'.repeat(256).slice(0, 4096);
  const bio = 'Reading notes across languages.\n閱讀筆記與翻譯持續更新。\n'.repeat(128).slice(0, 4096);
  const handle = 'international-reading-room'.padEnd(64, 'x');
  const links = Array.from({ length: 5 }, (_, index) => ({
    label: `${'閱讀紀錄與翻譯'.repeat(10).slice(0, 63)}${index + 1}`,
    url: `https://example.test/journal/${index + 1}`.padEnd(2048, 'x'),
  }));
  const cache = new QueryClient();
  cache.setQueryData(['exposure', 'anonymous'], []);
  const html = renderToString(
    createElement(QueryClientProvider, {
      client: cache,
      children: createElement(PublicProfilePage, {
        page: profilePage({ profile: { displayName, handle, bio, links } }),
        locale: 'en',
        messages: {
          unknown: 'Unknown',
          none: 'None',
          unlabelled: 'Account',
          sources: 'Sources',
          aliases: 'Aliases',
          details: 'Details',
        },
        publicRealms: true,
        renderJsonLd: false,
      }),
    }),
  );
  const heading = html.match(/<h1 class="([^"]+)">([\s\S]*?)<\/h1>/)!;
  expect(heading[1]).toContain('font-sans');
  expect(heading[1]).toContain('wrap-anywhere');
  expect(heading[2]).toBe(displayName);
  expect(html).toContain(`@${handle}</p></div><div data-slot="agent-description"`);
  const description = html.match(/data-slot="agent-description" class="([^"]+)">/)!;
  // The default phone body spans both avatar/name columns; desktop keeps its text column.
  expect(description[1]).toContain('col-span-full');
  expect(description[1]).toContain('sm:col-start-2');
  expect(html).toContain(bio);
  for (const link of links)
    expect(html).toContain(`href="${link.url}" rel="nofollow noopener noreferrer ugc">${link.label}</a>`);
  expect(html).not.toContain('followers');

  const realms = renderToString(
    createElement(PublicRealmsPage, {
      handle,
      title: displayName,
      locale: 'en',
      result: { state: 'ready', realms: [], next: 'signed+/=' },
    }),
  );
  expect(realms.match(/<h1 class="([^"]+)">/)![1]).toContain('font-sans');
  expect(realms).toContain(`href="/en/@${handle}"`);
  expect(realms).toContain(`href="/en/@${handle}/realms?cursor=signed%2B%2F%3D"`);

  const detail = detailExample(human.id);
  detail.account = { ...detail.account, handle, displayName };
  const management = renderToString(
    createElement(AccountManagementPage, {
      page: { state: 'ready', value: detail, issuer: null, organizationsAvailable: null },
      retry: () => {},
    }),
  );
  const identity = management.match(/data-slot="account-management-identity" class="([^"]+)">([\s\S]*?)<\/div>/)!;
  expect(identity[1]).toContain('grid');
  expect(identity[1]).toContain('gap-3');
  const destinations = [...identity[2]!.matchAll(/<a ([^>]+)>/g)].map((link) => ({
    href: link[1]!.match(/href="([^"]+)"/)![1],
    classes: link[1]!.match(/class="([^"]+)"/)![1],
  }));
  expect(destinations.map((link) => link.href)).toEqual([`/en/@${handle}`, '/en/settings']);
  for (const link of destinations) expect(link.classes).toContain('min-h-11');

  // Keep the original pattern on the established provider, with the same viewer as its reader.
  const story = await Bun.file(
    new URL('../src/stories/patterns/managed-account-detail.stories.tsx', import.meta.url),
  ).text();
  expect(story).toMatch(
    /<PatternStory visitor="Signed In"[^>]*>\s*<ConnectedDetail \{\.\.\.props\} \/>\s*<\/PatternStory>/,
  );
  expect(story).toContain('client.setQueryData(sessionQuery.queryKey,');
  expect(story).toContain('subject: human.id');
  expect(story).toContain('new ManagedAccountReader(human.id, organization.id, read)');
});
