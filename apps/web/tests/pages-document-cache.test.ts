import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cachePublicPage, publicPageCacheControl, recordPageReadCacheControl } from '../src/security/page-cache.ts';

// These document fixtures contain no nonce attributes. Nonce rewriting has its own cache tests.
class DocumentHtmlRewriter {
  on(): this {
    return this;
  }
  transform(response: Response): Response {
    return response;
  }
}
const originalHtmlRewriter = globalThis.HTMLRewriter;
beforeEach(() => {
  globalThis.HTMLRewriter = DocumentHtmlRewriter as never;
});
afterEach(() => {
  if (originalHtmlRewriter === undefined) delete (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
  else globalThis.HTMLRewriter = originalHtmlRewriter;
});

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
  const another = new Request(request, { headers: { 'if-none-match': '*' } });
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
      return new Response('Independent', { headers: { 'content-type': 'text/html' } });
    },
  });
  expect(independent.status).toBe(304);
  expect(independent.headers.get('cache-control')).toBe(publicPageCacheControl);
});

test('a warm public document never bypasses current nested native privacy or erasure', async () => {
  const url = 'https://rezics.test/en/subjects/rice';
  const entries = new Map<string, Response>();
  let matches = 0;
  let puts = 0;
  const cache = {
    async match(key: Request) {
      matches++;
      return entries.get(key.url)?.clone();
    },
    async put(key: Request, response: Response) {
      puts++;
      entries.set(key.url, response.clone());
    },
  };
  const options = {
    publicRoute: true,
    cache,
    buildId: 'documents',
    dehydratedData: () => ({ title: 'Rice' }),
  };
  const warm = await cachePublicPage(new Request(url), {
    ...options,
    async render() {
      return new Response('<article>Formerly public document</article>', { headers: { 'content-type': 'text/html' } });
    },
  });
  expect(warm.status).toBe(200);
  expect(entries.size).toBe(1);
  for (const status of [200, 404]) {
    for (const validator of [null, warm.headers.get('etag')!, '*']) {
      const request = new Request(url, { headers: validator ? { 'if-none-match': validator } : {} });
      let renders = 0;
      const response = await cachePublicPage(request, {
        ...options,
        dehydratedData: () => {
          throw new Error('private document data must not enter a validator');
        },
        async render() {
          renders++;
          recordPageReadCacheControl(request, 'private, no-store');
          recordPageReadCacheControl(request, 'public, max-age=60');
          return new Response('<article>Current native result</article>', {
            status,
            headers: { 'content-type': 'text/html' },
          });
        },
      });
      expect(renders).toBe(1);
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('etag')).toBeNull();
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
      expect(await response.text()).toBe('<article>Current native result</article>');
    }
  }
  expect(matches).toBe(1);
  expect(puts).toBe(1);
});
