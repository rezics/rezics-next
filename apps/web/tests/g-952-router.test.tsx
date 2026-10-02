import { afterEach, describe, expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { NextRequest } from 'next/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { proxy } from '../proxy.ts';
import type { ResolvedAddress } from '../features/address/client.ts';
import {
  resourceHref,
  siteMemberTarget,
  spaceHref,
  threadHref,
  zoneMemberHref,
} from '../features/address/path.ts';
import { decideAddress } from '../features/address/redirect.ts';
import { beforePathNormalization } from '../features/address/edge.ts';
import { privateDiscovery, readSpacePage, realmDiscovery } from '../features/address/space-read.ts';
import { joinPageFixture } from '../features/manage/settings-fixtures.ts';
import {
  realmHref,
  realmWorkHref,
  scopedWorkHref,
  siteHref,
  tabOf,
} from '../features/realm/route.ts';
import type { RealmHeader } from '../features/realm/types.ts';
import { SpaceDiscovery, spaceDiscoveryHeaders } from '../features/space-access/discovery.tsx';
import { realmRefFromPageUrl } from '../features/zones/page-missing.tsx';

const realm = joinPageFixture.id.slice(-36);
const space = joinPageFixture.space.slice(-36);
const work = '0199a0fe-0b21-7000-8000-123456789abc';
const iri = (id: string) => `https://rezics.com/id/${id}`;
const address: ResolvedAddress = {
  profile: 'address-resolution-v1',
  scope: 'space',
  key: 'books',
  status: 'resolved',
  state: 'current',
  holder: iri(space),
  canonical: { prefix: '/z/', key: 'books', slugSource: 'Books' },
  capabilities: { realm: iri(realm), zone: iri(work) },
};
const oldFetch = globalThis.fetch;
const oldClient = process.env.WEB_OAUTH_CLIENT_ID;
afterEach(() => {
  globalThis.fetch = oldFetch;
  process.env.WEB_OAUTH_CLIENT_ID = oldClient;
});

function serve(read: (url: URL, headers: Headers) => Response): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(url.pathname);
    return read(url, new Headers(init?.headers));
  }) as typeof fetch;
  return calls;
}
const absent = () => Response.json({ code: 'missing' }, { status: 404 });

describe('G-952 community and site addresses', () => {
  test('Main names and name policies win; identity-only inputs preserve all UUID bits', () => {
    expect(spaceHref(iri(space), 'community')).toBe(`/r/${uuidToSid(space)}`);
    expect(siteHref('ja', address.canonical, ['guide'])).toBe('/ja/z/books/guide');
    expect(realmHref('en', address.canonical, 'rules')).toBe('/en/r/books/rules');
    expect(realmHref('en', address.canonical, 'browse')).toBe('/en/z/books/browse');
    expect(resourceHref('/w/', { prefix: '/w/', key: '春の物語', slugSource: 'Story' })).toBe(
      '/w/%E6%98%A5%E3%81%AE%E7%89%A9%E8%AA%9E',
    );
    expect(
      zoneMemberHref(address.canonical, 'characters', {
        prefix: '/z/books/characters/',
        key: 'キリト',
        slugSource: '',
      }),
    ).toBe('/z/books/characters/%E3%82%AD%E3%83%AA%E3%83%88');
    expect(realmWorkHref('books', iri(work))).toBe(`/z/books/w/${uuidToSid(work)}`);
    expect(scopedWorkHref(iri(work), realm)).toBe(
      `/w/${uuidToSid(work)}?scope=realm&realm=${realm}`,
    );
    expect(tabOf('/en/z/books/about')).toBeNull();
    expect(realmRefFromPageUrl('https://rezics.test/en/z/books/missing')).toBe('books');
  });

  test('a global Work name never masquerades as a name in a mounted Zone route', () => {
    const global = { prefix: '/w/' as const, key: 'Spring-story', slugSource: 'Spring story' };
    expect(zoneMemberHref('books', 'catalogue', siteMemberTarget(iri(work), global))).toBe(
      `/z/books/catalogue/${uuidToSid(work)}`,
    );
    const mounted = { ...global, prefix: '/z/books/catalogue/' as const, key: '春の物語' };
    expect(zoneMemberHref('books', 'catalogue', siteMemberTarget(iri(work), mounted))).toBe(
      '/z/books/catalogue/%E6%98%A5%E3%81%AE%E7%89%A9%E8%AA%9E',
    );
  });

  test('legacy Space and reply UUIDs normalize together, keeping selections and anchors, then pass', async () => {
    const canonical = `/en/r/books/discussions/${uuidToSid(work)}?sort=new&language=sv#comments`;
    const resolve = async () => ({ kind: 'resolved' as const, data: address });
    expect(
      await decideAddress(
        new URL(
          `https://rezics.test/en/r/${realm}/discussions/${work}/?sort=new&language=sv#comments`,
        ),
        'en',
        resolve,
      ),
    ).toEqual({ kind: 'redirect', status: 301, location: canonical });
    expect(
      (await decideAddress(new URL(canonical, 'https://rezics.test'), 'en', resolve)).kind,
    ).toBe('pass');
    expect(threadHref('/r/books', iri(work))).toBe(`/r/books/discussions/${uuidToSid(work)}`);
  });

  test('a Zone without a Realm opens its site and never invents community links', async () => {
    const standalone = { ...address, capabilities: { zone: iri(work) } };
    const resolve = async () => ({ kind: 'resolved' as const, data: standalone });
    expect(
      (await decideAddress(new URL('https://rezics.test/en/z/books'), 'en', resolve)).kind,
    ).toBe('pass');
    expect(await decideAddress(new URL('https://rezics.test/en/r/books'), 'en', resolve)).toEqual({
      kind: 'redirect',
      status: 301,
      location: '/en/z/books',
    });
    expect(
      await decideAddress(new URL('https://rezics.test/en/r/books/rules'), 'en', resolve),
    ).toEqual({ kind: 'error', status: 404 });
    const calls = serve(() => {
      throw new Error('A standalone site has no Realm read');
    });
    expect(await readSpacePage('books', 'en', { address: standalone })).toEqual({
      kind: 'missing',
    });
    expect(calls).toEqual([]);
  });
});

describe('G-952 private Space landing admission', () => {
  test.each(['r', 'z', 'r-submit'])(
    '%s outsider reaches only Main’s limited request page and response discovery headers',
    async (surface) => {
      process.env.WEB_OAUTH_CLIENT_ID = 'g-952-test';
      const calls = serve((url, headers) => {
        expect(headers.has('authorization')).toBe(false);
        if (url.pathname === `/v1/realms/${realm}/join-page`) return Response.json(joinPageFixture);
        return absent();
      });
      const path =
        surface === 'r-submit'
          ? `/en/r/${uuidToSid(realm)}/submit`
          : `/en/${surface}/${uuidToSid(realm)}`;
      const response = await proxy(new NextRequest(new URL(path, 'https://rezics.test')));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(calls).toEqual([
        '/v1/addresses/resolve',
        `/v1/realms/${realm}`,
        `/v1/realms/${realm}/join-page`,
      ]);
    },
  );

  test('a denied name stays missing until the shared resolver supplies its Realm capability', async () => {
    const calls = serve(() => {
      throw new Error('The merged API has no per-Realm handle lookup');
    });
    for (const credentials of [{}, { token: 'member', actingSubject: iri(work) }]) {
      expect(await readSpacePage('private-books', 'ja', credentials)).toEqual({ kind: 'missing' });
    }
    expect(calls).toEqual([]);
  });

  test.each(['r', 'z'])(
    '%s invitation-only and absent Spaces keep identical 404 responses',
    async (surface) => {
      process.env.WEB_OAUTH_CLIENT_ID = 'g-952-test';
      serve(absent);
      const response = await proxy(
        new NextRequest(`https://rezics.test/en/${surface}/${uuidToSid(realm)}`),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const slash = await beforePathNormalization(
        new Request(`https://rezics.test/en/${surface}/${uuidToSid(realm)}/`),
      );
      expect(slash?.status).toBe(404);
      expect(slash?.headers.get('x-robots-tag')).toBe('noindex');
      expect(slash?.headers.get('referrer-policy')).toBe('no-referrer');
    },
  );

  test('an admitted member uses the live header with their actor; no join page or anonymous full header is substituted', async () => {
    const header = {
      profile: 'realm-read-v1',
      id: iri(realm),
      visibility: 'private',
      listing: 'listed',
      discovery: { indexable: false, robots: 'noindex', referrerPolicy: null },
    } as RealmHeader;
    const calls = serve((url, headers) => {
      expect(url.searchParams.get('actingSubject')).toBe(iri(work));
      expect(headers.get('authorization')).toBe('Bearer member');
      return Response.json(header);
    });
    expect(
      await readSpacePage(uuidToSid(realm), 'en', { token: 'member', actingSubject: iri(work) }),
    ).toEqual({ kind: 'realm', header });
    expect(calls).toEqual([`/v1/realms/${realm}`]);
    expect(realmDiscovery(header)).toEqual(privateDiscovery());
  });

  test('an unavailable or malformed landing read remains unavailable, never an indexable empty page', async () => {
    for (const landing of [
      new Response(null, { status: 503 }),
      Response.json({ ...joinPageFixture, id: iri(work) }),
    ]) {
      serve((url) => (url.pathname.endsWith('/join-page') ? landing : absent()));
      expect(await readSpacePage(realm, 'en')).toEqual({ kind: 'unavailable' });
    }
    process.env.WEB_OAUTH_CLIENT_ID = 'g-952-test';
    serve((url) =>
      url.pathname.endsWith('/join-page') ? new Response(null, { status: 503 }) : absent(),
    );
    const response = await proxy(new NextRequest(`https://rezics.test/en/r/${uuidToSid(realm)}`));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });
});

describe('G-952 discovery policy on both surfaces', () => {
  test('both proxy and Worker preserve unlisted policy on the one canonical redirect', async () => {
    process.env.WEB_OAUTH_CLIENT_ID = 'g-952-test';
    serve((url) =>
      url.pathname === '/v1/addresses/resolve'
        ? Response.json(address)
        : Response.json({
            profile: 'realm-read-v1',
            id: iri(realm),
            visibility: 'public',
            listing: 'unlisted',
            discovery: joinPageFixture.discovery,
          }),
    );
    const old = `https://rezics.test/en/z/${space}/?language=sv`;
    const responses = [
      await proxy(new NextRequest(old)),
      await beforePathNormalization(new Request(old)),
    ];
    for (const response of responses) {
      expect(response?.status).toBe(301);
      expect(response?.headers.get('location')).toBe('https://rezics.test/en/z/books?language=sv');
      expect(response?.headers.get('x-robots-tag')).toBe('noindex');
      expect(response?.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });
  test.each(['r', 'z'])(
    '%s unlisted canonical response carries both HTTP policies',
    async (surface) => {
      process.env.WEB_OAUTH_CLIENT_ID = 'g-952-test';
      serve((url) =>
        url.pathname === '/v1/addresses/resolve'
          ? Response.json(address)
          : Response.json({
              profile: 'realm-read-v1',
              id: iri(realm),
              visibility: 'public',
              listing: 'unlisted',
              discovery: joinPageFixture.discovery,
            }),
      );
      const response = await proxy(new NextRequest(`https://rezics.test/en/${surface}/books`));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    },
  );

  test('listed private pages suppress referrers even when the older Main policy omits it', () => {
    const discovery = privateDiscovery({
      indexable: false,
      robots: 'noindex',
      referrerPolicy: null,
    });
    expect(spaceDiscoveryHeaders(discovery)).toEqual({
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
    });
    const html = renderToStaticMarkup(<SpaceDiscovery discovery={discovery} />);
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain('name="referrer" content="no-referrer"');
  });
});
