import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { uuidToSid } from '@rezics/model/address';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FeedProvider } from '../features/feed/feed-context.tsx';
import { messages as feedMessages } from '../features/feed/messages.ts';
import { railData } from '../features/home/fixtures.ts';
import { messages as homeMessages } from '../features/home/messages.ts';
import { Rail } from '../features/home/rail.tsx';
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
import { WORK_MISSING_HEADER } from '../features/work-page/admission.ts';

const uuid = '0199a0fe-0b21-7000-8000-123456789abc';
const sid = uuidToSid(uuid);
const holder = `https://rezics.com/id/${uuid}`;
const space = uuidToSid('0199a0fe-0b21-7000-8000-123456789abd');
const url = (path: string) => new URL(path, 'https://rezics.test');
const answer = (scope: ResolvedAddress['scope'], prefix: ResolvedAddress['canonical']['prefix'], key = sid,
  suffixSource = '春の物語'): AddressRead => ({ kind: 'resolved', data: {
    profile: 'address-resolution-v1', scope, key, holder, state: 'current', status: 'resolved',
    canonical: { prefix, key, suffixSource },
    ...(scope === 'space' ? { capabilities: { realm: holder, zone: holder } } : {}),
  } });
const full = (read: AddressRead) => {
  if (read.kind !== 'resolved') throw new Error('Expected resolved fixture');
  return read.data;
};

describe('G-943 one address grammar', () => {
  test('sid, sid-suffix, UUID, name and native-script name retain one identity', () => {
    expect(parseAddressSegment(sid)).toEqual({ kind: 'sid', id: uuid, key: sid });
    for (const slug of ['a', 'stale-title', '春の物語', 'abcdefghijklm']) {
      expect(parseAddressSegment(`${sid}-${slug}`)).toEqual({ kind: 'sid-suffix', id: uuid, key: `${sid}-${slug}` });
    }
    expect(parseAddressSegment(uuid.toUpperCase())?.kind).toBe('uuid');
    expect(parseWorkRef(`${sid}-ignored`)).toEqual({ kind: 'id', id: uuid });
    expect(parseWorkRef('春の物語')).toEqual({ kind: 'alias', key: '春の物語' });
    expect(parseEntityRef(`${sid}-old`)).toBe(uuid);
    expect(parseConceptRef(`${sid}-old`)).toBe(uuid);
    expect(parseHandleSegment('@Mei-Lin')).toBe('Mei-Lin');
    expect(parseHandleSegment('@_old_name')).toBe('_old_name');
    expect(parseAddressSegment(`${uuidToSid('00000000-0000-0000-0000-000000000000')}-abcdefabcdefa`)?.kind)
      .toBe('sid-suffix');
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
    expect(canonicalHref({ prefix: '/e/', key: sid, suffixSource: '物語！ 春' }, 'ja'))
      .toBe(`/ja/e/${sid}-%E7%89%A9%E8%AA%9E-%E6%98%A5`);
    expect(canonicalHref({ prefix: '/concepts/', key: sid, suffixSource: 'كتاب جديد' }, 'en'))
      .toBe(`/en/concepts/${sid}-%D9%83%D8%AA%D8%A7%D8%A8-%D8%AC%D8%AF%D9%8A%D8%AF`);
    expect(canonicalHref({ prefix: '/a/', key: sid, suffixSource: '' }, 'en')).toBe(`/en/a/${sid}`);
    expect(canonicalHref({ prefix: '/w/', key: '春の物語', suffixSource: 'Other' }, 'ja'))
      .toBe('/ja/w/%E6%98%A5%E3%81%AE%E7%89%A9%E8%AA%9E');
    const address = { prefix: '/w/' as const, key: sid, suffixSource: 'Title' };
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
  let ownerReads = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const incoming = new Headers(init?.headers);
    expect(incoming.has('authorization')).toBe(false);
    expect(incoming.has('cookie')).toBe(false);
    if (url.pathname === `/v1/works/${uuid}`) {
      ownerReads++;
      return new Response(null, { status: 200 });
    }
    expect(url.pathname).toBe('/v1/addresses/resolve');
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
  expect(ownerReads).toBe(2);
});
test('a cached public Work that becomes private has the same admission refusal as a missing Work', async () => {
  const id = crypto.randomUUID();
  const key = uuidToSid(id);
  const missing = uuidToSid(crypto.randomUUID());
  const address = { ...full(answer('work', '/w/', key, '')), holder: `https://rezics.com/id/${id}` };
  let visible = true;
  let ownerReads = 0;
  let resolutions = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname === `/v1/works/${id}`) {
      ownerReads++;
      return new Response(null, { status: visible ? 200 : 404 });
    }
    expect(url.pathname).toBe('/v1/addresses/resolve');
    resolutions++;
    return url.searchParams.get('key') === key
      ? Response.json(address, { headers: { 'cache-control': 'public, max-age=60', etag: '"visible-work"' } })
      : new Response(null, { status: 404 });
  }) as typeof fetch;
  const path = `https://rezics.test/en/w/${key}`;
  const warm = await proxy(new NextRequest(path, { headers: { [WORK_MISSING_HEADER]: '1' } }));
  expect(warm.status).toBe(200);
  expect(warm.headers.get(`x-middleware-request-${WORK_MISSING_HEADER}`)).toBeNull();
  visible = false;
  const denied = await proxy(new NextRequest(path, { headers: { [ADDRESS_HEADER]: 'forged' } }));
  const absent = await proxy(new NextRequest(`https://rezics.test/en/w/${missing}`));
  for (const response of [denied, absent]) {
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get(`x-middleware-request-${WORK_MISSING_HEADER}`)).toBe('1');
    expect(response.headers.get(`x-middleware-request-${ADDRESS_HEADER}`)).toBeNull();
  }
  expect(resolutions).toBe(2);
  expect(ownerReads).toBe(2);
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

test('G-1002 address rule exempts explicit conformance oracles and checks ordinary tests, stories and product links', () => {
  const root = resolve(import.meta.dir, '../../..');
  mkdirSync(join(root, '.temp'), { recursive: true });
  const fixture = mkdtempSync(join(root, '.temp/g-1002-address-rule-'));
  try {
    const files = {
      'tests/g-943-address.test.ts': "const raw = '/a/0199a0fe-0b21-7000-8000-123456789abc';",
      'tests/g-990-uuid-address.test.ts': "const raw = '/@agent-0199a0fe-0b21-7000-8000-123456789abc';",
      'tests/g-943-address.e2e.ts': "const legacy = '/en/r/fiction/browse';",
      'tests/g-952-router.test.tsx': 'const raw = <Link href="/en/r/fiction/works" />;',
      'tests/ordinary-journey.test.ts': "const href = '/en/r/fiction';",
      'tests/ordinary-journey.test.tsx': 'const link = <Link href="/@reader" />;',
      'features/realm/route.ts': "const href = '/en/r/fiction';",
      'features/zones/official-fixtures.ts': "const href = '/en/z/books';",
      'features/g-943-address.ts': "const href = '/a/0199a0fe-0b21-7000-8000-123456789abc';",
      'features/ordinary-page.tsx': 'const link = <Link href="/en/z/books" />;',
      'features/ordinary-page.js': "const href = '/w/story';",
      'features/ordinary-page.jsx': 'const link = <Link href="/w/story" />;',
      'features/ordinary-page.stories.tsx': 'const link = <Link href="/en/r/fiction" />;',
      'features/builder-page.ts': "const href = resourceHref('/w/', id);",
      'features/builder-page.tsx': "const link = <Link href={spaceHref(space, 'site')} />;",
      'features/builder-page.js': "const href = resourceHref('/w/', id);",
    };
    for (const [path, source] of Object.entries(files)) {
      const file = join(fixture, 'apps/web', path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    // Run the real file filters: ast-grep's YAML snippet tests only test AST matches.
    writeFileSync(join(fixture, 'Taskfile.yml'), `version: '3'
tasks:
  scan:
    cmds:
      - '${join(root, 'node_modules/.bin/ast-grep')} scan --rule ${join(root, 'scripts/static/ast-grep/rules/web-links-use-address.yml')} --json=compact apps/web'
`);
    const result = Bun.spawnSync(['task', 'scan'], { cwd: fixture });
    expect(result.exitCode).not.toBe(0);
    const diagnostics = JSON.parse(result.stdout.toString()) as { file: string; ruleId: string }[];
    expect(diagnostics.map(({ file, ruleId }) => [file, ruleId]).sort()).toEqual([
      ['apps/web/tests/ordinary-journey.test.ts', 'web-links-use-address'],
      ['apps/web/tests/ordinary-journey.test.tsx', 'web-links-use-address-tsx'],
      ['apps/web/features/realm/route.ts', 'web-links-use-address'],
      ['apps/web/features/zones/official-fixtures.ts', 'web-links-use-address'],
      ['apps/web/features/g-943-address.ts', 'web-links-use-address'],
      ['apps/web/features/ordinary-page.tsx', 'web-links-use-address-tsx'],
      ['apps/web/features/ordinary-page.js', 'web-links-use-address-js'],
      ['apps/web/features/ordinary-page.jsx', 'web-links-use-address-js'],
      ['apps/web/features/ordinary-page.stories.tsx', 'web-links-use-address-tsx'],
    ].sort());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('G-1002 Home rail emits short Work and unnamed community identities and keeps a named community', () => {
  const unnamed = railData.suggestions[0]!;
  const named = railData.suggestions[1]!;
  const html = renderToStaticMarkup(createElement(FeedProvider, {
    locale: 'en', messages: feedMessages, now: 0, signedIn: false, actingSubject: null,
    signInHref: '/sign-in', avatarQuery: '', tab: 'all', followedRealms: null,
    children: createElement(Rail, {
      data: { ...railData, moderated: [], realmSegments: { [named.realm]: 'fiction' } },
      signedIn: false, locale: 'en', messages: homeMessages,
    }),
  }));
  const work = railData.trending.items[0]!.item.work.slice(-36);
  expect(html).toContain(`href="/en/w/${uuidToSid(work)}"`);
  expect(html).toContain(`href="/en/r/${uuidToSid(unnamed.realm.slice(-36))}"`);
  expect(html).toContain('href="/en/r/fiction"');
  expect(html).not.toContain(`href="/en/w/${work}"`);
  expect(html).not.toContain(`href="/en/r/${unnamed.realm.slice(-36)}"`);
});
