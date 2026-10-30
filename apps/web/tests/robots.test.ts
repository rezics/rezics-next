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
