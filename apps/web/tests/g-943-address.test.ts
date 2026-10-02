import { afterEach, describe, expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy.ts';
import { ADDRESS_HEADER, type AddressRead, readAddress, type ResolvedAddress } from '../features/address/client.ts';
import { addressPath, canonicalHref, canonicalRedirect, parseAddressSegment } from '../features/address/path.ts';
import { decideAddress } from '../features/address/redirect.ts';
import { parseWorkRef } from '../features/work-page/route.ts';
import { parseEntityRef } from '../features/entity-page/route.ts';
import { parseConceptRef } from '../features/concept/route.ts';
import { parseHandleSegment, profileHref } from '../features/profile/route.ts';
import { isZonePage } from '../features/zones/csp.ts';
import { beforePathNormalization } from '../features/address/edge.ts';
import { workViewAddress } from '../features/seo/work.ts';
import { representationPath } from '../features/seo/address.ts';
import { readRoster } from '../features/realm/read.ts';

const uuid = '0199a0fe-0b21-7000-8000-123456789abc';
const sid = uuidToSid(uuid);
const holder = `https://rezics.com/id/${uuid}`;
const space = uuidToSid('0199a0fe-0b21-7000-8000-123456789abd');
const url = (path: string) => new URL(path, 'https://rezics.test');
const answer = (scope: ResolvedAddress['scope'], prefix: ResolvedAddress['canonical']['prefix'], key = sid,
  slugSource = '春の物語'): AddressRead => ({ kind: 'resolved', data: {
    profile: 'address-resolution-v1', scope, key, holder, state: 'current', status: 'resolved',
    canonical: { prefix, key, slugSource },
    ...(scope === 'space' ? { capabilities: { realm: holder, zone: holder } } : {}),
  } });
const full = (read: AddressRead) => {
  if (read.kind !== 'resolved') throw new Error('Expected resolved fixture');
  return read.data;
};

describe('G-943 one address grammar', () => {
  test('sid, sid-slug, UUID, name and native-script name retain one identity', () => {
    expect(parseAddressSegment(sid)).toEqual({ kind: 'sid', id: uuid, key: sid });
    for (const slug of ['a', 'stale-title', '春の物語', 'abcdefghijklm']) {
      expect(parseAddressSegment(`${sid}-${slug}`)).toEqual({ kind: 'sid-slug', id: uuid, key: `${sid}-${slug}` });
    }
    expect(parseAddressSegment(uuid.toUpperCase())?.kind).toBe('uuid');
    expect(parseWorkRef(`${sid}-ignored`)).toEqual({ kind: 'id', id: uuid });
    expect(parseWorkRef('春の物語')).toEqual({ kind: 'slug', slug: '春の物語' });
    expect(parseEntityRef(`${sid}-old`)).toBe(uuid);
    expect(parseConceptRef(`${sid}-old`)).toBe(uuid);
    expect(parseHandleSegment('@Mei-Lin')).toBe('Mei-Lin');
    expect(parseHandleSegment('@_old_name')).toBe('_old_name');
    expect(parseAddressSegment(`${uuidToSid('00000000-0000-0000-0000-000000000000')}-abcdefabcdefa`)?.kind)
      .toBe('sid-slug');
    expect(profileHref(`agent-${uuid}`)).toBe(`/a/${sid}`);
  });
  test('path separators, malformed escapes and control characters never reach the resolver', () => {
    for (const value of ['', 'a/b', 'a\\b', 'a?b', 'a#b', 'a\u0000b', 'a'.repeat(513)]) {
      expect(parseAddressSegment(value)).toBeNull();
    }
    expect(addressPath('/en/w/%ZZ')).toBeNull();
    expect(addressPath('/en/r/new')).toBeNull();
    expect(addressPath('/api/main/v1/works')).toBeNull();
  });
  test('derived CJK and RTL slugs, empty names, and chosen names use proper encoding', () => {
    expect(canonicalHref({ prefix: '/e/', key: sid, slugSource: '物語！ 春' }, 'ja'))
      .toBe(`/ja/e/${sid}-%E7%89%A9%E8%AA%9E-%E6%98%A5`);
    expect(canonicalHref({ prefix: '/concepts/', key: sid, slugSource: 'كتاب جديد' }, 'en'))
      .toBe(`/en/concepts/${sid}-%D9%83%D8%AA%D8%A7%D8%A8-%D8%AC%D8%AF%D9%8A%D8%AF`);
    expect(canonicalHref({ prefix: '/a/', key: sid, slugSource: '' }, 'en')).toBe(`/en/a/${sid}`);
    expect(canonicalHref({ prefix: '/w/', key: '春の物語', slugSource: 'Other' }, 'ja'))
      .toBe('/ja/w/%E6%98%A5%E3%81%AE%E7%89%A9%E8%AA%9E');
    const address = { prefix: '/w/' as const, key: sid, slugSource: 'Title' };
    expect(canonicalRedirect(url(`/en/w/${sid}-title`), address, 'en')).toBeNull();
  });
  test('canonical annotations retain a content language outside the UI locales', () => {
    expect(workViewAddress('story', { tab: 'overview' }, { language: 'sv', scope: 'global' }))
      .toEqual({ path: '/w/story?language=sv', indexable: true });
    expect(representationPath(url(`/ja/e/${sid}-title?language=ar&version=first&cursor=next`)))
      .toBe(`/ja/e/${sid}-title?language=ar&version=first`);
  });
});

describe('G-943 exactly one permanent redirect', () => {
  for (const [scope, prefix] of [['agent', '/a/'], ['work', '/w/'], ['resource', '/e/'],
    ['concept', '/concepts/']] as const) {
    for (const form of [uuid, sid, `${sid}-stale`, 'old-name']) {
      test(`${scope}: ${form === uuid ? 'UUID' : form === sid ? 'bare sid' : form === 'old-name' ? 'old name' : 'stale slug'} → canonical 200 form`, async () => {
        const read = answer(scope, prefix, sid, 'Title');
        const resolve = async () => read;
        const result = await decideAddress(url(`/en${prefix}${form}/?language=sv&version=first&tag=a&tag=b#part`), 'en', resolve);
        expect(result).toEqual({ kind: 'redirect', status: 301,
          location: `/en${prefix}${sid}-title?language=sv&version=first&tag=a&tag=b#part` });
        expect((await decideAddress(url((result as { location: string }).location), 'en', resolve)).kind).toBe('pass');
      });
    }
  }
  test('name policy canonicalizes identity and old handles, preserving shelves', async () => {
    const read = answer('agent', '/@', 'mei-lin', 'Mei');
    for (const form of [`/a/${uuid}`, `/a/${sid}-mei`, `/@Old-Name`, `/@agent-${uuid}`]) {
      expect(await decideAddress(url(`/ja${form}/shelves/read?cursor=a+b`), 'ja', async () => read))
        .toEqual({ kind: 'redirect', status: 301, location: '/ja/@mei-lin/shelves/read?cursor=a+b' });
    }
    expect((await decideAddress(url('/ja/@mei-lin'), 'ja', async () => read)).kind).toBe('pass');
  });
  test('a Work at /e and an unlocalized legacy link go straight to /w', async () => {
    expect(await decideAddress(url(`/e/${uuid}/contents?language=sv`), 'zh-Hant', async () => answer('resource', '/w/', '故事')))
      .toEqual({ kind: 'redirect', status: 301, location: '/zh-Hant/w/%E6%95%85%E4%BA%8B/contents?language=sv' });
  });
  test('community and site share the Space address; no capability identity remains in links', async () => {
    const read = answer('space', '/z/', 'books', 'Books');
    for (const surface of ['r', 'z']) {
      expect(await decideAddress(url(`/en/${surface}/${uuid}`), 'en', async () => read))
        .toEqual({ kind: 'redirect', status: 301, location: `/en/${surface}/books` });
      expect((await decideAddress(url(`/en/${surface}/books`), 'en', async () => read)).kind).toBe('pass');
    }
    for (const tab of ['about', 'rules', 'members', 'decisions', 'discussions', 'submit']) {
      expect(addressPath(`/en/r/books/${tab}`)?.surface).toBe('community');
    }
    expect(addressPath('/en/r/books/discussions/thread')?.surface).toBe('community');
    for (const route of ['browse', 'works', 'catalogue', 'custom/deep/path']) {
      expect(addressPath(`/en/r/books/${route}`)?.surface).toBe('site');
    }
    expect(isZonePage('/en/z/books/about')).toBe(true);
    expect(isZonePage('/en/r/books/about')).toBe(false);
  });
  test('old site paths normalize both Space and member in a single hop', async () => {
    const lookups: unknown[] = [];
    const resolve = async (lookup: Parameters<typeof readAddress>[0]) => {
      lookups.push(lookup);
      return lookup.scope === 'space' ? answer('space', '/z/', 'books', 'Books')
        : answer(`zone:${holder}`, `/z/books/catalogue/`, 'new-title', 'New title');
    };
    expect(await decideAddress(url(`/en/r/${space}/catalogue/${sid}-old/discussion?language=sv#reply`), 'en', resolve))
      .toEqual({ kind: 'redirect', status: 301, location: '/en/z/books/catalogue/new-title/discussion?language=sv#reply' });
    expect(lookups).toEqual([{ scope: 'space', key: space },
      { scope: `zone:${holder}`, route: 'catalogue', key: `${sid}-old` }]);
    expect((await decideAddress(url('/en/z/books/catalogue/new-title/discussion?language=sv#reply'), 'en', resolve)).kind).toBe('pass');
    expect(await decideAddress(url('/en/r/books/works'), 'en', async () => answer('space', '/z/', 'books')))
      .toEqual({ kind: 'redirect', status: 301, location: '/en/z/books/browse' });
  });
  test('directory goes straight to Discover and retains query selections', async () => {
    expect(await decideAddress(url('/r/?q=books&type=works'), 'ja', async () => { throw new Error('No lookup'); }))
      .toEqual({ kind: 'redirect', status: 301, location: '/ja/discover?q=books&type=communities' });
  });
  test('a site needs no Realm; a Realm needs no site; missing capabilities answer 404', async () => {
    const site = full(answer('space', '/z/', 'books'));
    site.capabilities = { zone: holder };
    const community = { ...site, capabilities: { realm: holder } };
    expect((await decideAddress(url('/en/z/books'), 'en', async () => ({ kind: 'resolved', data: site }))).kind).toBe('pass');
    expect(await decideAddress(url('/en/r/books'), 'en', async () => ({ kind: 'resolved', data: site })))
      .toEqual({ kind: 'redirect', status: 301, location: '/en/z/books' });
    expect((await decideAddress(url('/en/r/books'), 'en', async () => ({ kind: 'resolved', data: community }))).kind).toBe('pass');
    expect(await decideAddress(url('/en/z/books'), 'en', async () => ({ kind: 'resolved', data: community })))
      .toEqual({ kind: 'error', status: 404 });
  });
  test('missing/denied, retired and infrastructure failure keep distinct statuses', async () => {
    for (const [kind, status] of [['missing', 404], ['retired', 410], ['unavailable', 503]] as const) {
      expect(await decideAddress(url(`/en/w/${sid}`), 'en', async () => ({ kind })))
        .toEqual({ kind: 'error', status });
    }
  });
  test('a private draft editor keeps its authenticated owner read until Main admits viewer-aware resolution', async () => {
    expect(await decideAddress(url(`/en/w/${uuid}/edit/parts`), 'en', async () => {
      throw new Error('Anonymous admission cannot gate the private editor');
    })).toEqual({ kind: 'pass' });
  });
});

const originalFetch = globalThis.fetch;
const originalClient = process.env.WEB_OAUTH_CLIENT_ID;
afterEach(() => { globalThis.fetch = originalFetch; process.env.WEB_OAUTH_CLIENT_ID = originalClient; });
test('G-943 proxy emits HTTP 301; resolver sends no credentials; canonical request carries trusted data', async () => {
  process.env.WEB_OAUTH_CLIENT_ID = 'g-943-test';
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const incoming = new Headers(init?.headers);
    expect(incoming.has('authorization')).toBe(false);
    expect(incoming.has('cookie')).toBe(false);
    expect(incoming.get('x-rezics-display-languages')).toBe('sv,ja');
    return Response.json(full(answer('work', '/w/', 'story', 'Story')));
  }) as typeof fetch;
  const old = await proxy(new NextRequest(`https://rezics.test/ja/w/${uuid}/contents/?language=sv&version=first`));
  expect(old.status).toBe(301);
  expect(old.headers.get('location')).toBe('https://rezics.test/ja/w/story/contents?language=sv&version=first');
  const canonical = await proxy(new NextRequest('https://rezics.test/ja/w/story?language=sv', {
    headers: { [ADDRESS_HEADER]: 'forged' },
  }));
  expect(canonical.status).toBe(200);
  expect(JSON.parse(decodeURIComponent(canonical.headers.get(`x-middleware-request-${ADDRESS_HEADER}`)!)).holder).toBe(holder);
});
test('G-943 proxy returns a non-indexable unavailable response rather than rendering an empty page', async () => {
  process.env.WEB_OAUTH_CLIENT_ID = 'g-943-test';
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
  const response = await proxy(new NextRequest(`https://rezics.test/en/w/${uuid}`));
  expect(response.status).toBe(503);
  expect(response.headers.get('x-robots-tag')).toBe('noindex');
});
test('G-943 Worker resolves a slash, locale and alias together before vinext can redirect', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    expect(String(input)).toStartWith('https://main.test/v1/addresses/resolve?');
    return Response.json(full(answer('work', '/w/', 'story', 'Story')));
  }) as typeof fetch;
  const response = await beforePathNormalization(new Request(`https://rezics.test/w/${uuid}/contents/?language=sv`,
    { headers: { cookie: 'rezics_locale=ja' } }), 'https://main.test');
  expect(response?.status).toBe(301);
  expect(response?.headers.get('location')).toBe('https://rezics.test/ja/w/story/contents?language=sv');
  expect(await beforePathNormalization(new Request('https://rezics.test/en/w/story'))).toBeNull();
});
test('G-943 members continue the public roster; a stale cursor never silently restarts', async () => {
  process.env.WEB_OAUTH_CLIENT_ID = 'g-943-test';
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls += 1;
    const request = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    expect(request.pathname).toBe(`/v1/realms/${uuid}/roster`);
    expect(request.searchParams.get('after')).toBe('stale+cursor');
    return Response.json({ code: 'cursor_moved' }, { status: 409 });
  }) as typeof fetch;
  expect(await readRoster(uuid, 'stale+cursor')).toEqual({ ok: false, failure: 'moved' });
  expect(calls).toBe(1);
});
test('G-943 native-script addresses pass through real HTTP headers without a ByteString error', async () => {
  process.env.WEB_OAUTH_CLIENT_ID = 'g-943-test';
  const read = full(answer('work', '/w/', '春の物語', '春の物語'));
  globalThis.fetch = (async () => Response.json(read)) as unknown as typeof fetch;
  const response = await proxy(new NextRequest('https://rezics.test/ja/w/%E6%98%A5%E3%81%AE%E7%89%A9%E8%AA%9E'));
  expect(response.status).toBe(200);
  const carried = response.headers.get(`x-middleware-request-${ADDRESS_HEADER}`)!;
  expect(carried).toMatch(/^[\x20-\x7e]+$/);
  expect(JSON.parse(decodeURIComponent(carried)).canonical).toEqual(read.canonical);
});
