import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { paraglideMiddleware } from './paraglide/server.js';
import { defineCustomServerStrategy, extractLocaleFromRequestAsync, extractLocaleFromRequestWithStrategies, localizeUrl, locales } from './paraglide/runtime.js';

defineCustomServerStrategy('custom-accept-language', {
  getLocale(request) {
    if (!request) return undefined;
    try {
      return extractLocaleFromRequestWithStrategies(request, ['url', 'cookie']);
    } catch {
      // Continue to the custom header strategy when neither runtime strategy matches.
    }
    return matchUiLocaleTag(request.headers.get('accept-language'));
  },
});

const fetchHandler = createStartHandler(defaultStreamHandler);
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      const locale = await extractLocaleFromRequestAsync(request);
      const location = localizeUrl(url, { locale });
      return new Response(null, { status: 302, headers: { Location: location.href, 'Cache-Control': 'private, no-store' } });
    }
    return paraglideMiddleware(request, () => fetchHandler(request)).then((response: Response) => {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });
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
    if (language === 'zh') return subtags.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans';
    const base = locales.find((locale) => locale.toLowerCase() === language);
    if (base) return base;
  }
  return undefined;
}
