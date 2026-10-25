import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { paraglideMiddleware } from './paraglide/server.js';
const fetchHandler = createStartHandler(defaultStreamHandler);
export default {
  fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      const cookies = request.headers.get('cookie') ?? '';
      const match = /(?:^|;\s*)rezics_locale=(en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?:;|$)/.exec(cookies);
      const locale = match?.[1] ?? negotiate(request.headers.get('accept-language'));
      return new Response(null, { status: 302, headers: { Location: `/${locale}/`, 'Cache-Control': 'private, no-store' } });
    }
    return paraglideMiddleware(request, () => fetchHandler(request)).then((response: Response) => {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });
  },
};
function negotiate(header: string | null): string {
  const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'];
  for (const entry of (header ?? '').split(',').map((part, index) => ({ part, index, q: Number(/;q=([0-9.]+)/.exec(part)?.[1] ?? 1) })).sort((a, b) => b.q - a.q || a.index - b.index)) {
    const tag = entry.part.split(';')[0]!.trim().toLowerCase();
    const exact = locales.find((locale) => locale.toLowerCase() === tag);
    if (exact) return exact;
    const [language, ...subtags] = tag.split('-');
    if (language === 'zh') return subtags.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans';
    const base = locales.find((locale) => locale.toLowerCase() === language);
    if (base) return base;
  }
  return 'en';
}
