import { pageHead } from '../shell/head';
import { coverSrc } from '../media/cover-src';
import type { Locale } from '../paraglide/runtime.js';
import type { SpacePageData } from './space';

export function communityPageHead(page: SpacePageData | undefined, origin: string, locale: string, path: string) {
  const context = { origin, locale: locale as Locale, path };
  if (!page) return pageHead({ robots: 'noindex, follow' }, context);
  const canonical = `${origin}/${locale}${path}`;
  const publicRealm = page.realm?.visibility === 'public' ? page.realm : null;
  const indexable = (!page.realm || !!publicRealm) && !['concealed', 'unavailable'].includes(page.realmCarrier ?? '');
  const description = page.space.summary || publicRealm?.summary || '';
  const cover = page.space.banner;
  const variant = cover?.variants.find((candidate) => candidate.format === 'webp') ?? cover?.variants.at(-1);
  const image =
    cover && variant && indexable
      ? {
          url: coverSrc(cover.media, variant.format, variant.width),
          width: variant.width,
          height: Math.max(1, Math.round((cover.height * variant.width) / cover.width)),
          alt: page.space.title,
        }
      : undefined;
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        name: page.space.title,
        description,
        url: canonical,
        inLanguage: locale,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'REZICS', item: `${origin}/${locale}` },
          ...(publicRealm
            ? [
                {
                  '@type': 'ListItem',
                  position: 2,
                  name: publicRealm.title,
                  item: path.startsWith('/spaces/')
                    ? canonical
                    : `${origin}/${locale}/realms/${encodeURIComponent(publicRealm.id)}`,
                },
                { '@type': 'ListItem', position: 3, name: page.space.title },
              ]
            : [{ '@type': 'ListItem', position: 2, name: page.space.title }]),
        ],
      },
    ],
  };
  return pageHead(
    {
      title: page.space.title,
      description,
      type: 'website',
      ...(image ? { image } : {}),
      ...(indexable ? {} : { robots: 'noindex, follow' }),
      jsonLd: graph,
    },
    context,
  );
}
