import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { paraglideMiddleware } from './paraglide/server.js';
import { defineCustomServerStrategy, extractLocaleFromRequestWithStrategies, locales } from './paraglide/runtime.js';

const pagePaths = new Set(['/login', '/signup', '/consent', '/recovery', '/security', '/step-up']);
const assetPrefix = '/auth-assets/';

defineCustomServerStrategy('custom-accept-language', {
  getLocale(request) {
    if (!request) return undefined;
    try {
      return extractLocaleFromRequestWithStrategies(request, ['cookie']);
    } catch {
      // Continue to weighted Accept-Language negotiation when the cookie has no supported locale.
    }
    return matchUiLocaleTag(request.headers.get('accept-language'));
  },
});

const fetchHandler = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (pagePaths.has(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      return paraglideMiddleware(request, () => fetchHandler(request));
    }

    if (url.pathname.startsWith(assetPrefix)) return new Response('Not Found', { status: 404 });

    if (import.meta.env.DEV && __AUTH_ORIGIN__) {
      const target = new URL(__AUTH_ORIGIN__);
      target.pathname = url.pathname;
      target.search = url.search;
      return fetch(new Request(target, request), { redirect: 'manual' });
    }

    // On the issuer host, fetch continues to Auth at the origin behind this route.
    if (pagePaths.has(url.pathname)) return fetch(request);

    return new Response('Not Found', { status: 404 });
  },
};

function matchUiLocaleTag(header: string | null): string | undefined {
  const entries = (header ?? '').split(',').map((part, index) => ({
    tag: part.split(';')[0]!.trim().toLowerCase(),
    index,
    quality: Number(/;\s*q=([0-9.]+)/i.exec(part)?.[1] ?? 1),
  }));
  entries.sort((left, right) => right.quality - left.quality || left.index - right.index);
  for (const { tag, quality } of entries) {
    if (quality <= 0) continue;
    const exact = locales.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const [language, ...subtags] = tag.split('-');
    if (language === 'zh')
      return subtags.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans';
    const base = locales.find((locale) => locale.toLowerCase() === language);
    if (base) return base;
  }
  return undefined;
}
