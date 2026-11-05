import { expect, test } from 'bun:test';
import { robotsResponse } from '../src/sitemap/robots.ts';
import { locales } from '../src/paraglide/runtime.js';

test('robots names the configured root sitemap and retains private path rules on an untrusted request host', async () => {
  const response = robotsResponse(new Request('https://untrusted.example/robots.txt'), {
    origin: 'https://public.example/',
    locales,
  })!;
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  const body = await response.text();
  expect(body).toContain('Sitemap: https://public.example/sitemap.xml\n');
  expect(body).not.toContain('untrusted.example');
  expect(body).toContain('Allow: /\n');
  for (const locale of locales)
    for (const route of ['/settings', '/library', '/orders', '/collections/new', '/boards/*/new', '/curate'])
      expect(body).toContain(`Disallow: /${locale}${route}\n`);
  for (const path of ['/auth/', '/api/', '/_serverFn/', '/checkout', '/orders/'])
    expect(body).toContain(`Disallow: ${path}\n`);
});

test('missing or invalid configured origins make robots unavailable without publishing a request-host fallback', async () => {
  for (const origin of [
    undefined,
    '',
    'https://',
    '/relative',
    'ftp://public.example',
    'https://user:password@public.example',
    'https://public.example/nested',
    'https://public.example/?query',
    'https://public.example/#fragment',
    'https://public.example//',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = robotsResponse(new Request('https://untrusted.example/robots.txt', { method }), {
        origin,
        locales,
      })!;
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await response.text()).toBe(method === 'HEAD' ? '' : 'Robots unavailable');
    }
  }
});

test('robots keeps HEAD, method rejection and unrelated-path behavior', async () => {
  const options = { origin: 'https://public.example', locales };
  const head = robotsResponse(new Request('https://untrusted.example/robots.txt', { method: 'HEAD' }), options)!;
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  const post = robotsResponse(new Request('https://untrusted.example/robots.txt', { method: 'POST' }), options)!;
  expect(post.status).toBe(405);
  expect(post.headers.get('allow')).toBe('GET, HEAD');
  expect(robotsResponse(new Request('https://untrusted.example/elsewhere'), { locales })).toBeUndefined();
});

// Match emitted Disallow rules using robots '*' and terminal '$' semantics, including query strings, rather than comparing
// route filenames or importing the production route list. The only Allow rule is the root default.
function disallowed(body: string, path: string): boolean {
  return body.split('\n').some((line) => {
    if (!line.startsWith('Disallow: ')) return false;
    const pattern = line.slice('Disallow: '.length);
    const anchored = pattern.endsWith('$');
    const expression = (anchored ? pattern.slice(0, -1) : pattern)
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${expression}${anchored ? '$' : ''}`).test(path);
  });
}

test('actual private account creator library and editor route families are disallowed without suppressing public readers', async () => {
  expect([...locales].sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']);
  const options = { origin: 'https://public.example', locales };
  const body = await robotsResponse(new Request('https://public.example/robots.txt'), options)!.text();
  // No explicit locale directives can mask a missing wildcard fallback in this second response.
  const fallback = await robotsResponse(new Request('https://public.example/robots.txt'), {
    ...options,
    locales: [],
  })!.text();
  for (const [directives, languages] of [
    [body, locales],
    [fallback, ['en']],
  ] as const) {
    for (const locale of languages) {
      for (const path of [
        '/accounts',
        '/accounts/managed-agent/verification',
        '/organizations/managed-studio',
        '/review/account-verifications',
        '/access/resource',
        '/settings',
        '/library/collections',
        '/library/progress/session',
        '/orders/order',
        '/entitlements/entitlement',
        '/creator/offers',
        '/creator/statements/statement?cursor=next',
        '/my/zones',
        '/my/zones/new',
        '/my/zones/book-club/edit',
        '/inbox',
        '/moderation/reports/report',
        '/moderation/decisions/decision',
        '/imports/review',
        '/collections/new',
        '/boards/book-club/new',
        '/boards/book-club/moderation',
        '/curate/presentation',
        '/catalogue/new',
        '/catalogue/publication?work=book',
        '/catalogue/recipe',
        '/contexts/new',
        '/contexts/editorial-context',
        '/editions/new?editionId=draft',
        '/realms/new',
        '/subjects/book/a-book/edit',
        '/subjects/book/a-book/edit?realm=book-club',
        '/subjects/book/a-book/edit/',
        '/subjects/book/a-book/relation-edit',
        '/subjects/book/a-book/authored',
        '/subjects/recipe/a-dish/recipe',
        '/subjects/book/a-book/terms',
        '/subjects/book/a-book/statement-consent?property=title',
        '/subjects/book/a-book/context-review?context=editorial-context',
      ]) {
        const localized = `/${locale}${path}`;
        expect({ path: localized, disallowed: disallowed(directives, localized) }).toEqual({
          path: localized,
          disallowed: true,
        });
      }
      for (const path of [
        '/subjects/book/a-book',
        '/subjects/book/a-book/editions',
        '/subjects/book/a-book/relations',
        '/subjects/book/a-book/sources',
        '/subjects/book/a-book/changes',
        '/@reader',
        '/@studio/collections',
        '/boards',
        '/boards/book-club',
        '/threads/thread/a-discussion',
        '/collections/published?labels=favourites&cursor=next',
        '/realms',
        '/realms/book-club',
        '/spaces/book-club',
        '/zones/book-club/reading',
        '/offers/offer',
        '/editions?cursor=next',
        '/editions/published',
        '/posts/post/revisions/revision',
        '/logs/published',
        '/catalogue/definitions',
        '/search?q=book&cursor=next',
        '/search/history',
      ]) {
        const localized = `/${locale}${path}`;
        expect({ path: localized, disallowed: disallowed(directives, localized) }).toEqual({
          path: localized,
          disallowed: false,
        });
      }
    }
  }
});
