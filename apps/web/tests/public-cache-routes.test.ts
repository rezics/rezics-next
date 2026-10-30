import { expect, mock, test } from 'bun:test';
import { publicCacheGrowthSample, publicCacheSamples } from './support/public-cache-samples.ts';

mock.module('cloudflare:workers', () => ({ env: {} }));

const [{ routeTree }, { isPublicCacheRequest }, { cachePublicPage }] = await Promise.all([
  import('../src/routeTree.gen'),
  import('../src/router.tsx'),
  import('../src/security/page-cache.ts'),
]);

type RouteNode = {
  options?: { id?: string; path?: string; staticData?: { publicCache?: boolean } };
  children?: Record<string, RouteNode>;
};

function markedRouteIds(route: RouteNode): string[] {
  const id = route.options?.id ?? route.options?.path;
  return [
    ...(route.options?.staticData?.publicCache === true && id ? [id] : []),
    ...Object.values(route.children ?? {}).flatMap(markedRouteIds),
  ];
}

class MemoryCache {
  private readonly entries = new Map<string, Response>();

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone());
  }
}

class FakeHtmlRewriter {
  on(): this {
    return this;
  }

  async transform(response: Response): Promise<Response> {
    return response;
  }
}

const originalHtmlRewriter = globalThis.HTMLRewriter;

test('the generated router marks only the public page routes for shared caching', () => {
  const expected = ['/', '/search', '/realms/$id', '/spaces/$address', '/boards/$id', '/threads/$id_/$slug'].toSorted();
  expect(markedRouteIds(routeTree as unknown as RouteNode).toSorted()).toEqual(expected);
  expect(Object.keys(publicCacheSamples).toSorted()).toEqual(expected);

  for (const path of Object.values(publicCacheSamples)) {
    expect(isPublicCacheRequest(new Request(`https://rezics.test${path}`))).toBe(true);
  }

  for (const path of [
    '/en/library/',
    '/en/settings',
    '/en/checkout',
    '/en/offers/offer-1',
    '/en/orders/order-1',
    '/en/curate/presentation',
    '/en/collections/new',
    '/en/boards/board-1/new',
  ]) {
    expect(isPublicCacheRequest(new Request(`https://rezics.test${path}`)), `${path} must stay private`).toBe(false);
  }
});

test('a recorded public thread uses the fake shared cache after its first anonymous render', async () => {
  globalThis.HTMLRewriter = FakeHtmlRewriter as never;
  const request = new Request(`https://rezics.test${publicCacheGrowthSample}`);
  let renderCalls = 0;
  const options = {
    publicRoute: isPublicCacheRequest(request),
    cache: new MemoryCache(),
    buildId: 'test-build',
    dehydratedData: () => ({ page: 'recorded-thread' }),
    freshNonce: () => 'fresh-nonce',
    render: async () => {
      renderCalls += 1;
      return new Response('<html><head></head><body>recorded thread</body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  };

  try {
    const first = await cachePublicPage(request, options);
    const second = await cachePublicPage(request, options);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
    expect(renderCalls).toBe(1);
  } finally {
    if (originalHtmlRewriter === undefined) delete (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
    else globalThis.HTMLRewriter = originalHtmlRewriter;
  }
});
