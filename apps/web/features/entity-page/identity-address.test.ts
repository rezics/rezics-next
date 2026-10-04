import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { proxy } from '../../proxy.ts';
import { resourceHref } from '../address/path.ts';
import { uuidToSid } from '@rezics/model/address';
import { sessionCookies } from '../auth/session-state.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function fixture({ signedIn = false, legacy = false } = {}) {
  const id = randomUUID(),
    actor = `https://rezics.com/id/${randomUUID()}`;
  const calls: string[] = [];
  let status = 200,
    pageStatus = 200,
    misses = 0,
    cache = false;
  const key = uuidToSid(id);
  const name = 'Confidential name';
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    calls.push(url.pathname);
    if (url.pathname === '/v1/me/session-agent')
      return Response.json({ sessionAgent: { eligible: true, actingSubject: actor } });
    if (url.pathname === '/v1/addresses/resolve') {
      if (signedIn) {
        expect(headers.get('authorization')).toStartWith('Bearer ');
        expect(url.searchParams.get('actingSubject')).toBe(actor);
      }
      if (status === 404) misses++;
      if (status !== 200) return new Response(null, { status });
      return Response.json(
        {
          profile: 'address-resolution-v1',
          status: 'resolved',
          scope: 'resource',
          key: url.searchParams.get('key'),
          holder: `https://rezics.com/id/${id}`,
          state: 'current',
          canonical: { prefix: '/e/', key, suffixSource: '' },
        },
        {
          headers: cache
            ? {
                'cache-control': 'public, max-age=30',
                etag: '"one"',
                vary: 'Authorization, Accept-Language, X-Rezics-Display-Languages',
              }
            : { 'cache-control': 'no-store' },
        },
      );
    }
    if (url.pathname === `/v1/resources/${id}/page`)
      return pageStatus === 200
        ? Response.json({ summary: { status: 'available', name: { value: name } } })
        : new Response(null, { status: pageStatus });
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;
  const path = `/en${resourceHref('/e/', legacy ? { prefix: '/e/', key: id, suffixSource: '' } : id)}`;
  const request = () => {
    const headers = new Headers();
    if (signedIn) {
      const token = `e30.${Buffer.from(JSON.stringify({ sub: 'member', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.signature`;
      const cookies = sessionCookies(
        'http://localhost',
        { accessToken: token, refreshToken: 'refresh', expiresIn: 300 },
        { id: 'member' },
      );
      headers.set('cookie', cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '));
    }
    return new NextRequest(`http://localhost${path}`, { headers });
  };
  return {
    calls,
    key,
    path,
    name,
    misses: () => misses,
    setStatus: (value: number) => {
      status = value;
    },
    setPageStatus: (value: number) => {
      pageStatus = value;
    },
    cache: () => {
      cache = true;
    },
    read: () => proxy(request()),
  };
}

test('resource address misses return one charged 404, noindex and no page or metadata probe', async () => {
  const f = fixture();
  f.setStatus(404);
  const result = await f.read();
  expect(result.status).toBe(404);
  expect(result.headers.get('x-robots-tag')).toBe('noindex');
  expect(await result.text()).toBe('');
  expect(f.calls).toEqual(['/v1/addresses/resolve']);
  expect(f.misses()).toBe(1);
});
test('admitted signed-in resources retain the single canonical 301 and recheck through the owner', async () => {
  const f = fixture({ signedIn: true, legacy: true });
  const result = await f.read();
  expect(result.status).toBe(301);
  expect(new URL(result.headers.get('location')!).pathname).toBe(
    `/en${resourceHref('/e/', f.key)}`,
  );
  expect(f.calls.filter((path) => path === '/v1/addresses/resolve')).toHaveLength(1);
  expect(f.calls.some((path) => path.endsWith('/page'))).toBe(true);
  expect(f.misses()).toBe(0);
});
test('a cached public hit never turns revoked reading into a 200 shell; the new miss is charged once', async () => {
  const f = fixture();
  f.cache();
  expect((await f.read()).status).toBe(200);
  f.setStatus(404);
  f.setPageStatus(404);
  const result = await f.read();
  expect(result.status).toBe(404);
  expect(result.headers.get('x-robots-tag')).toBe('noindex');
  expect(await result.text()).not.toContain(f.name);
  expect(f.misses()).toBe(1);
  expect(f.calls.filter((path) => path === '/v1/addresses/resolve')).toHaveLength(2);
});
test('retired and unavailable resource addresses retain 410 and 503 without owner probes', async () => {
  for (const status of [410, 503]) {
    const f = fixture();
    f.setStatus(status);
    expect((await f.read()).status).toBe(status);
    expect(f.calls).toEqual(['/v1/addresses/resolve']);
  }
});
