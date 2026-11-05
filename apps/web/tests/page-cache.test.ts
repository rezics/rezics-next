import { afterEach, expect, test } from 'bun:test';
import { createRootRoute, createRoute } from '@tanstack/react-router';
import { authRequest } from '../src/session/routes.ts';
import {
  cachePublicPage,
  cachedNoncePlaceholder,
  createPageEtag,
  isPublicCacheRoute,
  privateServerFunctionResponse,
  recordPageReadCacheControl,
  recordPublicPageCachePolicy,
  recordPublicPageFailure,
} from '../src/security/page-cache.ts';
import { cookie } from '../src/session/cookies.ts';
import { prepareSession, requestCsrfToken } from '../src/session/request.ts';

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
  expect(first.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=0, must-revalidate');
  const representation = { data, status: 200, html: await html(cachedNoncePlaceholder).text() };
  expect(first.headers.get('etag')).toBe(await createPageEtag(request.url, 'build-a', representation));
  expect(first.headers.get('etag')).toMatch(/^W\/"/);
  expect(first.headers.has('set-cookie')).toBe(false);
  const firstBody = await first.text();
  expect(firstBody).toContain('nonce="nonce-first"');
  expect(firstBody).toContain('content="nonce-first"');

  const etag = first.headers.get('etag')!;
  let currentRenders = 0;
  const conditional = await cachePublicPage(new Request(request.url, { headers: { 'if-none-match': etag } }), {
    publicRoute: testPublicRouteEnabled,
    cache,
    buildId: 'build-a',
    dehydratedData: () => data,
    freshNonce: () => 'nonce-second',
    render: async () => {
      currentRenders += 1;
      return html('nonce-origin');
    },
  });
  expect(currentRenders).toBe(1);
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe('');
  expect(conditional.headers.get('etag')).toBe(etag);
  expect(conditional.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=0, must-revalidate');
  expect(conditional.headers.has('content-security-policy')).toBe(false);
  expect(await createPageEtag(request.url, 'build-b', representation)).not.toBe(etag);
  expect(await createPageEtag('https://rezics.test/en/test-only?sort=top', 'build-a', representation)).not.toBe(etag);
  expect(
    await createPageEtag(request.url, 'build-a', {
      ...representation,
      data: { ...data, router: { dehydrated: { page: 'two' } } },
    }),
  ).not.toBe(etag);
  expect(
    await createPageEtag(request.url, 'build-a', {
      ...representation,
      data: { ...data, query: { dehydrated: ['changed'] } },
    }),
  ).not.toBe(etag);
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

test('second anonymous GET renders current disclosure before cached nonce rewriting', async () => {
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
  expect(kernelRequests).toBe(2);
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
  expect(missing.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=0, must-revalidate');
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
  expect(post.headers.get('cache-control')).not.toBe('public, max-age=0, s-maxage=0, must-revalidate');
  expect(serverFn.headers.get('cache-control')).not.toBe('public, max-age=0, s-maxage=0, must-revalidate');
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

test('native private and no-store HTML and unsuccessful outcomes never become public or conditional responses', async () => {
  const request = new Request('https://rezics.test/en/test-only', { headers: { 'if-none-match': '*' } });
  const cache = new MemoryCache();
  for (const [status, cacheControl] of [
    [200, 'no-store'],
    [200, 'PUBLIC, max-age=60, No-Store'],
    [200, 'private, max-age=60'],
    [200, 'private="set-cookie"'],
    [404, 'private, no-store'],
    [202, undefined],
    [403, undefined],
    [500, undefined],
    [503, undefined],
  ] as const) {
    let dataReads = 0;
    const response = await cachePublicPage(request, {
      publicRoute: true,
      cache,
      buildId: 'build-a',
      dehydratedData: () => {
        dataReads += 1;
        return { mustNotBePublic: true };
      },
      render: async () =>
        html('native-nonce', status, { etag: '"native"', ...(cacheControl ? { 'cache-control': cacheControl } : {}) }),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.has('etag')).toBe(false);
    expect(response.headers.get('content-security-policy')).toContain("'nonce-native-nonce'");
    expect(await response.text()).toContain('nonce="native-nonce"');
    expect(dataReads).toBe(0);
  }
  expect(cache.puts).toBe(0);
});

test('cookie and Authorization requests bypass a warm public entry without public headers or a 304', async () => {
  globalThis.HTMLRewriter = TestHtmlRewriter as never;
  const cache = new MemoryCache();
  const url = 'https://rezics.test/en/test-only';
  const options = {
    publicRoute: true,
    cache,
    buildId: 'build-a',
    dehydratedData: () => ({}),
    freshNonce: () => 'fresh',
    render: async () => html('public', 200, { vary: 'Cookie, Accept-Language' }),
  };
  const publicResponse = await cachePublicPage(new Request(url), options);
  const etag = publicResponse.headers.get('etag')!;
  for (const credentials of [{ cookie: '__Host-rezics_session=opaque' }, { authorization: 'Bearer private' }]) {
    let renders = 0;
    const response = await cachePublicPage(new Request(url, { headers: { ...credentials, 'if-none-match': etag } }), {
      ...options,
      dehydratedData: () => {
        throw new Error('a bypass must not compute a public validator');
      },
      render: async () => {
        renders += 1;
        return html('uncached');
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.has('etag')).toBe(false);
    expect(await response.text()).toContain('nonce="uncached"');
    expect(renders).toBe(1);
  }
  expect(cache.matches).toBe(1);
  expect(cache.puts).toBe(1);
});

test('private cached entries and caught public render failures cannot supply a cached or fresh 304', async () => {
  const cache = new MemoryCache();
  const request = new Request('https://rezics.test/en/test-only', { headers: { 'if-none-match': '*' } });
  await cache.put(request, html('private', 200, { 'cache-control': 'private, no-store', etag: '"old"' }));
  for (const fail of [
    () => recordPublicPageFailure(request, 503),
    () => {
      try {
        requestCsrfToken(request);
      } catch {
        /* The route renders its error boundary. */
      }
    },
  ]) {
    const response = await cachePublicPage(request, {
      publicRoute: true,
      cache,
      buildId: 'build-a',
      dehydratedData: () => {
        throw new Error('an error fallback must not compute a public validator');
      },
      render: async () => {
        fail();
        return html('fallback');
      },
    });
    expect([500, 503]).toContain(response.status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.has('etag')).toBe(false);
    expect(await response.text()).toContain('nonce="fallback"');
  }
  expect(cache.puts).toBe(1);
});

test('warm public 200 and 404 entries never mask current withdrawal, closure or preparation', async () => {
  globalThis.HTMLRewriter = TestHtmlRewriter as never;
  const cases = [
    { change: 'hide', path: 'subjects/book/title', status: 404 },
    { change: 'erasure', path: '@writer', status: 404 },
    { change: 'revocation', path: 'threads/thread/title', status: 404, control: 'no-store' },
    { change: 'grant closure', path: 'boards/board', status: 403 },
    { change: 'private transition', path: 'realms/realm', status: 200, control: 'private' },
    { change: 'preparing', path: 'spaces/space', status: 202 },
    { change: 'unavailable', path: 'threads/thread/title', status: 503 },
    { change: 'private Collection', path: 'collections/list', status: 404 },
  ];
  for (const { change, path, status, control } of cases) {
    for (const warmStatus of [200, 404]) {
      const cache = new MemoryCache();
      const url = `https://rezics.test/en/${path}`;
      // Seed both positive and negative entries, including entries from the old TTL policy.
      await cache.put(
        new Request(url),
        html('old', warmStatus, {
          'cache-control': 'public, max-age=0, s-maxage=60',
          etag: 'W/"old"',
        }),
      );
      for (const validator of [null, 'W/"old"', '*']) {
        const request = new Request(url, { headers: validator ? { 'if-none-match': validator } : {} });
        let renders = 0;
        const response = await cachePublicPage(request, {
          publicRoute: true,
          cache,
          buildId: 'build-a',
          dehydratedData: () => {
            throw new Error(`${change} must not compute a public validator`);
          },
          render: async () => {
            renders += 1;
            return html('current', status, control ? { 'cache-control': control } : undefined);
          },
        });
        expect(response.status, `${change} after ${warmStatus}`).toBe(status);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('x-robots-tag')).toBe('noindex');
        expect(response.headers.has('etag')).toBe(false);
        expect(await response.text()).toContain('nonce="current"');
        expect(renders).toBe(1);
      }
      expect(cache.matches).toBe(0);
      expect(cache.puts).toBe(1);
    }
  }
});

test('current complete HTML and status determine validators even when loader titles are unchanged', async () => {
  globalThis.HTMLRewriter = TestHtmlRewriter as never;
  for (const warmStatus of [200, 404]) {
    const cache = new MemoryCache();
    const url = 'https://rezics.test/en/threads/thread/title';
    const options = {
      publicRoute: true,
      cache,
      buildId: 'build-a',
      dehydratedData: () => ({ title: 'Unchanged' }),
      freshNonce: () => 'delivery',
    };
    const first = await cachePublicPage(new Request(url), {
      ...options,
      render: async () =>
        new Response('<article>Withdrawn dependency</article>', {
          status: warmStatus,
          headers: { 'content-type': 'text/html' },
        }),
    });
    let renders = 0;
    const current = await cachePublicPage(
      new Request(url, { headers: { 'if-none-match': first.headers.get('etag')! } }),
      {
        ...options,
        render: async () => {
          renders += 1;
          return new Response('<article>Current public content</article>', {
            headers: { 'content-type': 'text/html' },
          });
        },
      },
    );
    expect(current.status).toBe(200);
    expect(current.headers.get('etag')).not.toBe(first.headers.get('etag'));
    expect(await current.text()).toBe('<article>Current public content</article>');
    expect(renders).toBe(1);
    const missing = await cachePublicPage(new Request(url, { headers: { 'if-none-match': '*' } }), {
      ...options,
      render: async () =>
        new Response('<article>Current public content</article>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('etag')).not.toBe(current.headers.get('etag'));
  }
});

test('warm public HTML still requires current native policies and uncaught render failures', async () => {
  globalThis.HTMLRewriter = TestHtmlRewriter as never;
  for (const path of ['threads/thread/title', 'collections/list']) {
    const cache = new MemoryCache();
    const url = `https://rezics.test/en/${path}`;
    const options = {
      publicRoute: true,
      cache,
      buildId: 'build-a',
      dehydratedData: () => ({ title: 'Public' }),
      render: async () => html('public'),
    };
    const warmRequest = new Request(url);
    const warm = await cachePublicPage(warmRequest, {
      ...options,
      render: async () => {
        recordPublicPageCachePolicy(warmRequest, 'public');
        return html('public');
      },
    });
    const request = new Request(url, { headers: { 'if-none-match': warm.headers.get('etag')! } });
    const current = await cachePublicPage(request, {
      ...options,
      render: async () => {
        if (path.startsWith('collections')) recordPublicPageCachePolicy(request, 'private');
        else recordPageReadCacheControl(request, 'private, no-store');
        return html('current');
      },
    });
    expect(current.status).toBe(200);
    expect(current.headers.get('cache-control')).toBe('private, no-store');
    expect(current.headers.has('etag')).toBe(false);
    expect(await current.text()).toContain('nonce="current"');
    await expect(
      cachePublicPage(new Request(url), {
        ...options,
        render: async () => {
          throw new Error('current source failed');
        },
      }),
    ).rejects.toThrow('current source failed');
    expect(cache.matches).toBe(1);
    expect(cache.puts).toBe(1);
  }
});

test('current public conditional responses keep fresh variant headers through cache hits and outages', async () => {
  globalThis.HTMLRewriter = TestHtmlRewriter as never;
  const cache = new MemoryCache();
  const url = 'https://rezics.test/en/threads/thread/title';
  const options = {
    publicRoute: true,
    cache,
    buildId: 'build-a',
    dehydratedData: () => ({ title: 'Public' }),
    render: async () => html('origin'),
  };
  const warm = await cachePublicPage(new Request(url), options);
  const etag = warm.headers.get('etag')!;
  let renders = 0;
  for (const currentCache of [
    cache,
    {
      async match(): Promise<Response | undefined> {
        throw new Error('cache unavailable');
      },
      async put(): Promise<void> {
        throw new Error('cache unavailable');
      },
    },
  ]) {
    for (const validator of [etag, `"different", ${etag.replace(/^W\//, '')}`, '*']) {
      const response = await cachePublicPage(new Request(url, { headers: { 'if-none-match': validator } }), {
        ...options,
        cache: currentCache,
        render: async () => {
          renders++;
          return html('new-origin-nonce', 200, {
            vary: 'Cookie, Accept-Language',
            'content-location': '/en/threads/thread/title',
          });
        },
      });
      expect(response.status).toBe(304);
      expect(response.headers.get('etag')).toBe(etag);
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=0, must-revalidate');
      expect(response.headers.get('vary')).toBe('Cookie, Accept-Language');
      expect(response.headers.get('content-location')).toBe('/en/threads/thread/title');
      expect(response.headers.has('content-security-policy')).toBe(false);
      expect(await response.text()).toBe('');
    }
  }
  expect(renders).toBe(6);
});

test('a restrictive read or caught failure during streamed HTML cannot become a warm conditional success', async () => {
  globalThis.HTMLRewriter = TestHtmlRewriter as never;
  for (const failure of [false, true]) {
    const request = new Request('https://rezics.test/en/threads/thread/title', { headers: { 'if-none-match': '*' } });
    const cache = new MemoryCache();
    await cache.put(request, html('old', 200, { 'cache-control': 'public, max-age=0, s-maxage=60', etag: 'W/"old"' }));
    const response = await cachePublicPage(request, {
      publicRoute: true,
      cache,
      buildId: 'build-a',
      freshNonce: () => 'current',
      dehydratedData: () => {
        throw new Error('a streamed failure must not compute a public validator');
      },
      render: async () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (failure) recordPublicPageFailure(request, 503);
                else recordPageReadCacheControl(request, 'private, no-store');
                controller.enqueue(new TextEncoder().encode('<article>Current result</article>'));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'content-type': 'text/html' } },
        ),
    });
    expect(response.status).toBe(failure ? 503 : 200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.has('etag')).toBe(false);
    expect(await response.text()).toBe('<article>Current result</article>');
    expect(cache.matches).toBe(0);
    expect(cache.puts).toBe(1);
  }
});
