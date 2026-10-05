import { afterEach, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { uuidToSid } from '@rezics/model/address';
import { proxy } from '../proxy.ts';
import { beforePathNormalization } from '../features/address/edge.ts';
import { resolvedAddress, type ResolvedAddress } from '../features/address/client.ts';
import { decideAddress } from '../features/address/redirect.ts';
import { uiLocales } from '../i18n/define.ts';
import { ACCESS_COOKIE, SESSION_COOKIE } from '../features/auth/cookies.ts';
import { encodeSessionRecord } from '../features/auth/session-state.ts';

const post = '00000000-0000-4000-8000-000000000001';
const book = uuidToSid('00000000-0000-4000-8000-000000000002');
const occurrence = '00000000-0000-4000-8000-000000000003';
const alias = 'retained-chapter';
const answer = (contents = false): ResolvedAddress => ({
  profile: 'address-resolution-v1',
  scope: 'work',
  key: alias,
  holder: `https://rezics.com/id/${post}`,
  status: 'resolved',
  state: 'redirect',
  canonical: {
    // ast-grep-ignore: web-links-use-address -- This is Main's complete canonical reader place fixture.
    prefix: contents ? `/w/${book}/` : `/w/${book}/read/`,
    key: contents ? 'contents' : occurrence,
    suffixSource: '',
  },
});
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('the address client admits Main reader places while refusing UUIDs as canonical Work keys', () => {
  expect(resolvedAddress(answer())).toEqual(answer());
  expect(resolvedAddress(answer(true))).toEqual(answer(true));
  expect(
    resolvedAddress({ ...answer(), canonical: { prefix: '/w/', key: post, suffixSource: '' } }),
  ).toBeNull();
});

test('former chapter ID and alias requests answer 301 before rendering in every locale', async () => {
  globalThis.fetch = (async () => Response.json(answer())) as unknown as typeof fetch;
  for (const locale of uiLocales) {
    for (const key of [post, uuidToSid(post), alias]) {
      // ast-grep-ignore: web-links-use-address -- This explicitly probes retained chapter Work addresses.
      const url = `https://rezics.test/${locale}/w/${key}?language=sv`;
      const response = await proxy(new NextRequest(url, { method: 'HEAD' }));
      expect(response.status).toBe(301);
      expect(response.headers.get('location')).toBe(
        // ast-grep-ignore: web-links-use-address -- Independent final reader path assertion.
        `https://rezics.test/${locale}/w/${book}/read/${occurrence}?language=sv`,
      );
    }
  }
});

test('the Worker combines a trailing slash and old Work tab into one reader or Contents 301', async () => {
  for (const contents of [false, true]) {
    globalThis.fetch = (async () => Response.json(answer(contents))) as unknown as typeof fetch;
    const response = await beforePathNormalization(
      // ast-grep-ignore: web-links-use-address -- A retained alias tab is a legacy lookup, not a generated link.
      new Request(`https://rezics.test/zh-Hant/w/${alias}/about/?language=en`, { method: 'HEAD' }),
      'https://main.test',
    );
    expect(response?.status).toBe(301);
    expect(response?.headers.get('location')).toBe(
      // ast-grep-ignore: web-links-use-address -- Independent final reader/Contents path assertion.
      `https://rezics.test/zh-Hant/w/${book}/${contents ? 'contents' : `read/${occurrence}`}?language=en`,
    );
  }
});

test('a retired chapter alias keeps 410 and an unreadable placement does not redirect', async () => {
  // ast-grep-ignore: web-links-use-address -- This probes the retained alias disposition.
  const url = new URL(`https://rezics.test/en/w/${alias}`);
  expect(await decideAddress(url, 'en', async () => ({ kind: 'retired' }))).toEqual({
    kind: 'error',
    status: 410,
  });
  expect(await decideAddress(url, 'en', async () => ({ kind: 'missing' }))).toEqual({
    kind: 'error',
    status: 404,
  });
});

test('a signed-in chapter reader resolves as their session Agent before rendering', async () => {
  const actor = `https://rezics.com/id/${post}`;
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'chapter-reader' })).toString('base64url')}.signature`;
  const record = encodeSessionRecord({
    user: { id: 'chapter-reader' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  let resolvedAsReader = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname === '/v1/me/session-agent') {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      return Response.json({ sessionAgent: { eligible: true, actingSubject: actor } });
    }
    expect(url.pathname).toBe('/v1/addresses/resolve');
    expect(url.searchParams.get('actingSubject')).toBe(actor);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    resolvedAsReader = true;
    return Response.json(answer());
  }) as unknown as typeof fetch;
  const response = await proxy(
    // ast-grep-ignore: web-links-use-address -- The retained chapter alias must resolve using live reader authority.
    new NextRequest(`https://rezics.test/en/w/${alias}`, {
      method: 'HEAD',
      headers: { cookie: `${ACCESS_COOKIE}=${token}; ${SESSION_COOKIE}=${record}` },
    }),
  );
  expect(response.status).toBe(301);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(resolvedAsReader).toBe(true);
  const slash = await beforePathNormalization(
    // ast-grep-ignore: web-links-use-address -- A private retained alias must resolve before slash normalization too.
    new Request(`https://rezics.test/zh-Hant/w/${alias}/`, {
      method: 'HEAD',
      headers: { cookie: `${ACCESS_COOKIE}=${token}; ${SESSION_COOKIE}=${record}` },
    }),
    'https://main.test',
  );
  expect(slash?.status).toBe(301);
  expect(slash?.headers.get('cache-control')).toBe('private, no-store');
});
