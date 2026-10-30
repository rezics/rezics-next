import { expect, test } from 'bun:test';
import { cachePublicPage, recordPageReadCacheControl } from '../src/security/page-cache.ts';

test('a private native document aggregate cannot enter the shared HTML cache or become a conditional success', async () => {
  const request = new Request('https://rezics.test/en/subjects/rice', { headers: { 'if-none-match': '*' } });
  const stored: Response[] = [];
  const response = await cachePublicPage(request, {
    publicRoute: true,
    buildId: 'documents',
    dehydratedData: () => ({ body: 'Simmer for 25 minutes.' }),
    cache: {
      async match() {
        return undefined;
      },
      async put(_key, response) {
        stored.push(response);
      },
    },
    async render() {
      recordPageReadCacheControl(request, 'private, no-store');
      return new Response('<ol><li>Simmer for 25 minutes.</li></ol>', { headers: { 'content-type': 'text/html' } });
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('etag')).toBeNull();
  expect(await response.text()).toBe('<ol><li>Simmer for 25 minutes.</li></ol>');
  expect(stored).toEqual([]);
});

test('restrictive read policies belong to the exact request and survive a later public read', async () => {
  const request = new Request('https://rezics.test/en/subjects/rice');
  const another = new Request(request);
  recordPageReadCacheControl(request, 'private');
  recordPageReadCacheControl(request, 'public, max-age=60');
  let rendered = 0;
  const response = await cachePublicPage(request, {
    publicRoute: true,
    buildId: 'documents',
    dehydratedData: () => null,
    async render() {
      rendered++;
      return new Response('Private body');
    },
  });
  expect(rendered).toBe(1);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const independent = await cachePublicPage(another, {
    publicRoute: true,
    buildId: 'documents',
    dehydratedData: () => null,
    async render() {
      return new Response('Independent', { headers: { 'cache-control': 'no-cache' } });
    },
  });
  expect(independent.headers.get('cache-control')).toBe('no-cache');
});
