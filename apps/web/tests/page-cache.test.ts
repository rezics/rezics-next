import { afterEach, expect, test } from 'bun:test';
import { createRootRoute, createRoute } from '@tanstack/react-router';
import { authRequest } from '../src/session/routes.ts';
import {
  cachePublicPage,
  createPageEtag,
  isPublicCacheRoute,
  privateServerFunctionResponse,
} from '../src/security/page-cache.ts';
import { cookie } from '../src/session/cookies.ts';
import { prepareSession } from '../src/session/request.ts';

type CacheEntry = { request: Request; response: Response };
class MemoryCache {
  readonly entries = new Map<string, CacheEntry>();
  matches = 0;
  puts = 0;
  async match(request: Request): Promise<Response | undefined> {
    this.matches += 1;
    return this.entries.get(request.url)?.response.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.puts += 1;
    this.entries.set(request.url, { request, response: response.clone() });
  }
}

class TestHtmlRewriter {
  private handlers: Array<{ selector: string; element: { element: (element: TestElement) => void } }> = [];
  on(selector: string, handler: { element: (element: TestElement) => void }): this {
    this.handlers.push({ selector, element: handler });
    return this;
  }
  async transform(response: Response): Promise<Response> {
    const source = await response.text();
    const html = source.replace(/<([a-z][^>]*)>/gi, (tag) => {
      const attrs = new Map<string, string>();
      const name = /^<([a-z][\w-]*)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
      for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs.set(match[1]!.toLowerCase(), match[2]!);
      const element: TestElement = {
        tagName: name,
        getAttribute: (key) => attrs.get(key.toLowerCase()) ?? null,
        setAttribute: (key, value) => attrs.set(key.toLowerCase(), value),
      };
      for (const entry of this.handlers) {
        if (entry.selector === '[nonce]' && attrs.has('nonce')) entry.element.element(element);
        if (entry.selector === 'meta[property="csp-nonce"]' && name === 'meta' && attrs.get('property') === 'csp-nonce')
          entry.element.element(element);
      }
      const attrText = [...attrs].map(([key, value]) => ` ${key}="${value}"`).join('');
      return `<${name}${attrText}${tag.endsWith('/>') ? '/>' : '>'}`;
    });
    return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
type TestElement = {
  tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
};

const originalHtmlRewriter = globalThis.HTMLRewriter;
afterEach(() => {
  if (originalHtmlRewriter === undefined) delete (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
  else globalThis.HTMLRewriter = originalHtmlRewriter;
});

const testRootRoute = createRootRoute();
const publicTestRoute = createRoute({
  getParentRoute: () => testRootRoute,
  path: '/test-only',
  staticData: { publicCache: true },
});
const privateTestRoute = createRoute({
  getParentRoute: () => testRootRoute,
  path: '/private-test-only',
  staticData: { publicCache: false },
});
const testPublicRouteEnabled = isPublicCacheRoute([publicTestRoute.options]);
const html = (nonce: string, status = 200, headers?: HeadersInit) =>
  new Response(
    `<html><head><meta property="csp-nonce" content="${nonce}"></head><body><script nonce="${nonce}">1</script><style nonce="${nonce}">x</style></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `script-src 'nonce-${nonce}'`,
        ...Object.fromEntries(new Headers(headers)),
      },
    },
  );

test('a test-only publicCache route gets a build/data ETag and conditional GET omits CSP', async () => {
  globalThis.HTMLRewriter = TestHtmlRewriter as never;
  expect(testPublicRouteEnabled).toBe(true);
  expect(isPublicCacheRoute([privateTestRoute.options])).toBe(false);
  const cache = new MemoryCache();
  const data = { router: { dehydrated: { page: 'one' } }, query: { dehydrated: [] } };
  const request = new Request('https://rezics.test/en/test-only?sort=recent');
  const first = await cachePublicPage(request, {
    publicRoute: testPublicRouteEnabled,
    cache,
    buildId: 'build-a',
    dehydratedData: () => data,
    freshNonce: () => 'nonce-first',
    render: async () => html('nonce-origin'),
  });
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  expect(first.headers.get('etag')).toBe(await createPageEtag(request.url, 'build-a', data));
  expect(first.headers.get('etag')).toMatch(/^W\/"/);
  expect(first.headers.has('set-cookie')).toBe(false);
  const firstBody = await first.text();
  expect(firstBody).toContain('nonce="nonce-first"');
  expect(firstBody).toContain('content="nonce-first"');

  const etag = first.headers.get('etag')!;
  const conditional = await cachePublicPage(new Request(request.url, { headers: { 'if-none-match': etag } }), {
    publicRoute: testPublicRouteEnabled,
    cache,
    buildId: 'build-a',
    dehydratedData: () => data,
    freshNonce: () => 'nonce-second',
    render: async () => {
      throw new Error('a cached conditional GET must not render');
    },
  });
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe('');
  expect(conditional.headers.get('etag')).toBe(etag);
  expect(conditional.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  expect(conditional.headers.has('content-security-policy')).toBe(false);
  expect(await createPageEtag(request.url, 'build-b', data)).not.toBe(etag);
  expect(await createPageEtag('https://rezics.test/en/test-only?sort=top', 'build-a', data)).not.toBe(etag);
  expect(await createPageEtag(request.url, 'build-a', { ...data, router: { dehydrated: { page: 'two' } } })).not.toBe(
    etag,
  );
  expect(await createPageEtag(request.url, 'build-a', { ...data, query: { dehydrated: ['changed'] } })).not.toBe(etag);
});

test('publicCache render refuses session and cookie reads', async () => {
  const request = new Request('https://rezics.test/en/test-only');
  const read = () =>
    cachePublicPage(request, {
      publicRoute: testPublicRouteEnabled,
      cache: new MemoryCache(),
      buildId: 'build-a',
      dehydratedData: () => ({}),
      freshNonce: () => 'nonce',
      render: async () => {
        cookie(request, '__Host-rezics_session');
        return html('nonce');
      },
    });
  await expect(read()).rejects.toThrow(/publicCache route.*session|session.*publicCache route/i);

  const sessionRead = () =>
    cachePublicPage(request, {
      publicRoute: testPublicRouteEnabled,
      cache: new MemoryCache(),
      buildId: 'build-a',
      dehydratedData: () => ({}),
      freshNonce: () => 'nonce',
      render: async () => {
        await prepareSession(request, {});
        return html('nonce');
      },
    });
  await expect(sessionRead()).rejects.toThrow(/publicCache route.*session|session.*publicCache route/i);

  const authRead = () =>
    cachePublicPage(request, {
      publicRoute: testPublicRouteEnabled,
      cache: new MemoryCache(),
      buildId: 'build-a',
      dehydratedData: () => ({}),
      freshNonce: () => 'nonce',
      render: async () => {
        await authRequest(request, {});
        return html('nonce');
      },
    });
  await expect(authRead()).rejects.toThrow(/publicCache route.*Auth|Auth.*publicCache route/i);
});

test('second anonymous GET hits Workers Cache API and rewrites CSP, nonce attributes, and nonce meta', async () => {
  globalThis.HTMLRewriter = TestHtmlRewriter as never;
  const cache = new MemoryCache();
  const request = new Request('https://rezics.test/en/test-only?sort=recent');
  const data = { router: { page: 'one' }, query: [] };
  let kernelRequests = 0;
  const options = (nonce: string) => ({
    publicRoute: testPublicRouteEnabled,
    cache,
    buildId: 'build-a',
    dehydratedData: () => data,
    freshNonce: () => nonce,
    render: async () => {
      kernelRequests += 1;
      return html(`origin-${kernelRequests}`);
    },
  });
  const first = await cachePublicPage(request, options('nonce-first'));
  const second = await cachePublicPage(request, options('nonce-second'));
  expect(kernelRequests).toBe(1);
  expect(cache.entries.size).toBe(1);
  expect([...cache.entries.get(request.url)!.request.headers]).toEqual([]);
  expect(second.headers.get('content-security-policy')).toContain("'nonce-nonce-second'");
  const secondBody = await second.text();
  expect(secondBody).toContain('nonce="nonce-second"');
  expect(secondBody.match(/nonce="nonce-second"/g)).toHaveLength(2);
  expect(secondBody).toContain('content="nonce-second"');
  expect(await first.text()).toContain('nonce="nonce-first"');
});

test('Set-Cookie, non-200/non-404, POST, server functions, and personal server functions stay private', async () => {
  globalThis.HTMLRewriter = TestHtmlRewriter as never;
  const cache = new MemoryCache();
  const request = new Request('https://rezics.test/en/test-only');
  const renderResponse = (response: Response) =>
    cachePublicPage(request, {
      publicRoute: testPublicRouteEnabled,
      cache,
      buildId: 'build-a',
      dehydratedData: () => ({}),
      freshNonce: () => 'nonce',
      render: async () => response,
    });
  expect((await renderResponse(html('nonce', 200, { 'set-cookie': 'a=b' }))).headers.get('cache-control')).toBe(
    'private, no-store',
  );
  await renderResponse(html('nonce', 503));
  await renderResponse(html('nonce', 302));
  expect(cache.entries.size).toBe(0);

  const missing = await cachePublicPage(request, {
    publicRoute: testPublicRouteEnabled,
    cache,
    buildId: 'build-a',
    dehydratedData: () => ({ missing: true }),
    freshNonce: () => 'nonce-404',
    render: async () => html('origin-404', 404),
  });
  expect(missing.status).toBe(404);
  expect(missing.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  expect(missing.headers.get('etag')).toMatch(/^W\/"/);
  expect(missing.headers.has('set-cookie')).toBe(false);
  expect(cache.entries.size).toBe(1);
  cache.entries.clear();
  cache.matches = 0;
  cache.puts = 0;

  const post = await cachePublicPage(new Request(request, { method: 'POST' }), {
    publicRoute: testPublicRouteEnabled,
    cache,
    buildId: 'build-a',
    dehydratedData: () => ({}),
    freshNonce: () => 'nonce',
    render: async () => html('nonce'),
  });
  const serverFn = await cachePublicPage(new Request('https://rezics.test/_serverFn/private-read'), {
    publicRoute: testPublicRouteEnabled,
    cache,
    buildId: 'build-a',
    dehydratedData: () => ({}),
    freshNonce: () => 'nonce',
    render: async () => html('nonce'),
  });
  expect(post.headers.get('cache-control')).not.toBe('public, max-age=0, s-maxage=60');
  expect(serverFn.headers.get('cache-control')).not.toBe('public, max-age=0, s-maxage=60');
  expect(cache.entries.size).toBe(0);
  expect(cache.matches).toBe(0);
  expect(cache.puts).toBe(0);
  expect(privateServerFunctionResponse(new Response('private')).headers.get('cache-control')).toBe('private, no-store');

  for (const url of [
    'https://rezics.test/media/cover',
    'https://rezics.test/auth/sign-in',
    'https://rezics.test/checkout',
    'https://rezics.test/en/test-only',
  ]) {
    const headers = url.endsWith('/test-only') ? { authorization: 'Bearer private' } : undefined;
    await cachePublicPage(new Request(url, { ...(headers ? { headers } : {}) }), {
      publicRoute: testPublicRouteEnabled,
      cache,
      buildId: 'build-a',
      dehydratedData: () => ({}),
      freshNonce: () => 'nonce',
      render: async () => html('nonce'),
    });
  }
  expect(cache.matches).toBe(0);
  expect(cache.puts).toBe(0);
});
