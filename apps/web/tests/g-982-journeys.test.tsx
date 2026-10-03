import { afterEach, beforeAll, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMetadataToHtml } from 'vinext/shims/metadata';
import { readSpacePage } from '../features/address/space-read.ts';
import { realmHref } from '../features/realm/route.ts';
import { decideAddress } from '../features/address/redirect.ts';
import type { ResolvedAddress } from '../features/address/client.ts';
import { joinPageFixture } from '../features/manage/settings-fixtures.ts';
import { PrivateSpaceJoinPage } from '../features/space-access/join-page.tsx';
import { UnlistedSpaceNotice } from '../features/space-access/unlisted-notice.tsx';
import { parseBrowseState, browseHref, browseQuery } from '../features/discover/browse-state.ts';
import { discoveryApi } from '../features/discover/api.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';

beforeAll(seedServedTypes);
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const address: ResolvedAddress = {
  profile: 'address-resolution-v1',
  scope: 'space',
  key: 'private-books',
  status: 'resolved',
  state: 'current',
  holder: joinPageFixture.space,
  canonical: { prefix: '/r/', key: 'private-books', suffixSource: '' },
  capabilities: { realm: joinPageFixture.id },
};

test('G982: a named private request address reaches only the join page with its heading', async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    paths.push(url.pathname);
    return url.pathname.endsWith('/join-page')
      ? Response.json(joinPageFixture)
      : new Response(null, { status: 404 });
  }) as typeof fetch;
  expect(
    await decideAddress(new URL(realmHref('en', 'private-books'), 'https://web.test'), 'en', async () => ({
      kind: 'resolved',
      data: address,
    })),
  ).toEqual({ kind: 'pass', data: address });
  expect(
    await readSpacePage('private-books', 'en', { address, origin: 'https://main.test' }),
  ).toEqual({ kind: 'join', page: joinPageFixture });
  expect(paths).toEqual([
    `/v1/realms/${joinPageFixture.id.slice(-36)}`,
    `/v1/realms/${joinPageFixture.id.slice(-36)}/join-page`,
  ]);
  const html = renderToStaticMarkup(
    <PrivateSpaceJoinPage
      page={joinPageFixture}
      locale="en"
      actingSubject={null}
      signInHref="/auth/start?next=%2Fen%2Fr%2Fprivate-books"
      discoveryMetadata={false}
    />,
  );
  expect(html).toContain(`<h1`);
  expect(html).toContain(joinPageFixture.name.value);
});

test.each(['en', 'zh-Hant'] as const)(
  'G982: %s route-owned private and unlisted metadata renders one robots policy',
  (locale) => {
    const head = renderMetadataToHtml({ robots: { index: false }, referrer: 'no-referrer' });
    for (const component of [
      <PrivateSpaceJoinPage
        page={joinPageFixture}
        locale={locale}
        actingSubject={null}
        signInHref="/sign-in"
        discoveryMetadata={false}
      />,
      <UnlistedSpaceNotice
        locale={locale}
        discovery={joinPageFixture.discovery}
        discoveryMetadata={false}
      />,
    ]) {
      const html = head + renderToStaticMarkup(component);
      expect(html.match(/name="robots"/g)).toHaveLength(1);
      expect(html).toContain('content="noindex"');
      expect(html.match(/name="referrer"/g)).toHaveLength(1);
    }
    // Standalone components (including Storybook) still carry the policy.
    const standalone = renderToStaticMarkup(
      <PrivateSpaceJoinPage
        page={joinPageFixture}
        locale={locale}
        actingSubject={null}
        signInHref="/sign-in"
      />,
    );
    expect(standalone.match(/name="robots"/g)).toHaveLength(1);
  },
);

test('G982: Communities continuation preserves its type and selection and renders a distinct second page', async () => {
  const calls: unknown[] = [];
  const api = discoveryApi(
    {
      v1: {
        query: {
          post: async (query: ReturnType<typeof browseQuery>) => {
            calls.push(query);
            const continued = query.cursor === 'communities-next';
            return {
              error: null,
              data: {
                result: {
                  profile: 'resource-list-v1',
                  items: Array.from({ length: continued ? 5 : 20 }, (_, index) => ({
                    id: `community-${index + (continued ? 20 : 0)}`,
                  })),
                  nextCursor: continued ? null : 'communities-next',
                  complete: continued,
                  count: { kind: 'exact', value: 25 },
                },
              },
            };
          },
        },
      },
    },
    'en',
  );
  const first = parseBrowseState({ tab: 'communities', personalization: 'off' })!;
  const firstPage = await api.resources(browseQuery(first));
  const href = browseHref({ ...first, cursor: firstPage.nextCursor });
  const second = parseBrowseState(
    Object.fromEntries(new URL(href, 'https://web.test').searchParams),
  )!;
  const secondPage = await api.resources(browseQuery(second));
  expect(secondPage.items).toHaveLength(5);
  expect(
    secondPage.items.some((item) => firstPage.items.some((previous) => previous.id === item.id)),
  ).toBe(false);
  expect(calls[1]).toEqual({ ...(calls[0] as object), cursor: 'communities-next' });
  expect(second.tab).toBe('communities');
  expect(second.personalized).toBe(false);
});
