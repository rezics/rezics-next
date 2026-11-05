import { getLocale, locales, type Locale } from '../paraglide/runtime.js';

export type PagePaths = Record<Locale, string>;
export type HeadContext = { origin: string; locale: Locale; path: string; paths?: PagePaths };
type PageHeadOptions = {
  title?: string;
  description?: string;
  image?: string | { url: string; width: number; height: number; alt: string };
  type?: string;
  robots?: string;
  jsonLd?: unknown;
};

function cleanPath(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] || '/';
  return clean === '/' ? '' : `/${clean.replace(/^\/+|\/+$/g, '')}`;
}
export function pageLinks(origin: string, locale: Locale, path: string, paths?: PagePaths) {
  const current = cleanPath(paths?.[locale] ?? path);
  return [
    { rel: 'canonical', href: `${origin}/${locale}${current}` },
    ...locales.map((language) => ({
      rel: 'alternate',
      hrefLang: language,
      href: `${origin}/${language}${cleanPath(paths?.[language] ?? path)}`,
    })),
    { rel: 'alternate', hrefLang: 'x-default', href: `${origin}${current || '/'}` },
  ];
}
function descriptionText(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= 160) return text;
  const cut = text.slice(0, 161);
  const boundary = cut.lastIndexOf(' ');
  return (boundary > 0 ? cut.slice(0, boundary) : text.slice(0, 160)).trimEnd();
}
export function pageHead(options: PageHeadOptions, context?: HeadContext) {
  if (!context) {
    if (typeof window === 'undefined') throw new Error('Page head requires the public origin and current path');
    const locale = getLocale();
    const origin = new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin;
    context = { origin, locale, path: window.location.pathname.replace(new RegExp(`^/${locale}(?=/|$)`), '') || '/' };
  }
  const { origin, locale, path, paths } = context;
  const canonical = pageLinks(origin, locale, path, paths)[0]!.href;
  const title = options.title ? `${options.title} – REZICS` : 'REZICS';
  const description = options.description === undefined ? undefined : descriptionText(options.description);
  const image =
    typeof options.image === 'string'
      ? { url: options.image, width: 1200, height: 630, alt: title }
      : (options.image ?? { url: '/cards/default.png', width: 1200, height: 630, alt: 'REZICS' });
  const imageUrl = new URL(image.url, `${origin}/`);
  if (imageUrl.origin !== origin) throw new Error('Page head image must use PUBLIC_ORIGIN');
  const meta = [
    { title },
    ...(description === undefined
      ? []
      : [
          { name: 'description', content: description },
          { property: 'og:description', content: description },
          { name: 'twitter:description', content: description },
        ]),
    { property: 'og:title', content: title },
    { name: 'twitter:title', content: title },
    { property: 'og:url', content: canonical },
    { property: 'og:type', content: options.type ?? 'website' },
    { property: 'og:site_name', content: 'REZICS' },
    { property: 'og:locale', content: locale },
    { property: 'og:image', content: imageUrl.href },
    { property: 'og:image:width', content: String(image.width) },
    { property: 'og:image:height', content: String(image.height) },
    { property: 'og:image:alt', content: image.alt },
    { name: 'twitter:image', content: imageUrl.href },
    { name: 'twitter:image:alt', content: image.alt },
    { name: 'twitter:card', content: 'summary_large_image' },
    ...(options.robots ? [{ name: 'robots', content: options.robots }] : []),
  ];
  const scripts =
    options.jsonLd === undefined
      ? []
      : [{ type: 'application/ld+json', children: JSON.stringify(options.jsonLd).replaceAll('<', '\\u003c') }];
  return { meta, scripts };
}
