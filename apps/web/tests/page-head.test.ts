import { expect, test } from 'bun:test';
import { pageHead, pageLinks } from '../src/shell/head.ts';
import { validatePublicOrigin } from '../src/shell/origin.ts';
import { errorPageHead, routeFailure } from '../src/shell/error-state';
import { PlatformClosedError } from '../src/kernel/platform-closed';
import { notFound } from '@tanstack/react-router';

const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const origin = 'https://public.example';

test('canonical and reciprocal alternates use configured origin and page paths', () => {
  const paths = Object.fromEntries(locales.map((locale) => [locale, `/subjects/${locale}`]));
  for (const locale of locales) {
    const links = pageLinks(origin, locale, '/subjects/current?ignored=yes', paths);
    expect(links.filter((link) => link.rel === 'canonical')).toEqual([
      { rel: 'canonical', href: `${origin}/${locale}/subjects/${locale}` },
    ]);
    expect(links.filter((link) => link.rel === 'alternate')).toEqual([
      ...locales.map((language) => ({
        rel: 'alternate',
        hrefLang: language,
        href: `${origin}/${language}/subjects/${language}`,
      })),
      { rel: 'alternate', hrefLang: 'x-default', href: `${origin}/subjects/${locale}` },
    ]);
  }
  const fallback = pageLinks(origin, 'en', '/search?q=one');
  expect(fallback[0]?.href).toBe(`${origin}/en/search`);
  expect(fallback.at(-1)?.href).toBe(`${origin}/search`);
});

test('page head creates descriptive metadata and safely serialized structured data', () => {
  const description = 'A descriptive phrase '.repeat(12);
  const head = pageHead(
    { title: 'Example', description, robots: 'noindex, follow', jsonLd: { name: '</script>' } },
    { origin, locale: 'en', path: '/example' },
  );
  expect(head.meta).toContainEqual({ title: 'Example – REZICS' });
  const meta = (key: string) =>
    head.meta.find(
      (entry) => ('name' in entry && entry.name === key) || ('property' in entry && entry.property === key),
    ) as { content: string };
  expect(meta('description').content.length).toBeLessThanOrEqual(160);
  expect(description.startsWith(meta('description').content)).toBe(true);
  expect(meta('description').content).not.toEndWith(' ');
  expect(meta('og:description').content).toBe(meta('description').content);
  expect(meta('og:url').content).toBe(`${origin}/en/example`);
  expect(meta('og:image').content).toBe(`${origin}/cards/default.png`);
  expect(meta('og:image:width').content).toBe('1200');
  expect(meta('og:image:height').content).toBe('630');
  expect(meta('og:image:alt').content).toBeTruthy();
  expect(meta('twitter:card').content).toBe('summary_large_image');
  expect(meta('robots').content).toBe('noindex, follow');
  expect(head.scripts).toHaveLength(1);
  expect(head.scripts[0]?.children).not.toContain('<');
  expect(JSON.parse(head.scripts[0]!.children)).toEqual({ name: '</script>' });
  expect(pageHead({}, { origin, locale: 'en', path: '/' }).meta).toContainEqual({ title: 'REZICS' });
});

test('public origin must be an absolute HTTP origin', () => {
  for (const value of [
    '',
    'example.com',
    'https://example.com/path',
    'https://example.com?q=1',
    'ftp://example.com',
    'https://user@example.com',
  ]) {
    expect(() => validatePublicOrigin(value)).toThrow(/PUBLIC_ORIGIN/);
  }
  expect(validatePublicOrigin(origin)).toBe(origin);
  expect(validatePublicOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  expect(validatePublicOrigin('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
  expect(validatePublicOrigin(undefined, 'http://127.0.0.1:3000/en')).toBe('http://127.0.0.1:3000');
  expect(() => validatePublicOrigin(undefined, 'https://example.com/en')).toThrow(/PUBLIC_ORIGIN/);
});

test('shared route errors preserve native failures, conceal missing targets and exclude successful locale paths', () => {
  const root = { status: 'success' };
  const generic = { status: 'error', error: new Error('private dependency detail') };
  expect(routeFailure([root, generic])?.status).toBe(500);
  expect(routeFailure([root, generic], 503)?.status).toBe(503);
  expect(routeFailure([generic])?.status).toBe(500);
  expect(routeFailure([generic], 503)?.status).toBe(503);
  expect(routeFailure([root, { status: 'notFound', error: notFound() }])?.status).toBe(404);
  expect(routeFailure([root, { status: 'error', error: new PlatformClosedError(403, {}) }])?.status).toBe(403);
  const unavailable = routeFailure([
    root,
    {
      status: 'error',
      error: { problem: { status: 503 }, headers: { 'retry-after': '7', 'x-private-cause': 'secret' } },
    },
  ]);
  expect(unavailable).toEqual({ status: 503, closed: false, missing: false, retryAfter: '7' });
  for (const status of [200, 302, 600, NaN]) {
    expect(routeFailure([root, { status: 'error', error: { status } }])?.status).toBe(500);
  }
  expect(routeFailure([root, { status: 'success' }])).toBeUndefined();
  for (const locale of locales) {
    const head = errorPageHead({
      origin,
      locale,
      path: '/failed',
      paths: Object.fromEntries(locales.map((l) => [l, '/private-title'])) as Record<typeof locale, string>,
    });
    expect(head.meta).toContainEqual({ name: 'robots', content: 'noindex' });
    expect(head.meta).toContainEqual({ property: 'og:url', content: `${origin}/${locale}/failed` });
    expect(JSON.stringify(head)).not.toContain('private');
    expect(head.scripts).toEqual([]);
  }
});
